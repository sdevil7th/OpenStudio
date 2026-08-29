import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const frontendDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const lockfilePath = path.join(frontendDirectory, 'package-lock.json');
const outputPath = path.join(frontendDirectory, 'THIRD_PARTY_NOTICES.txt');
const nodeModulesDirectory = path.join(frontendDirectory, 'node_modules');
const noticeFilePattern = /^(?:licen[cs]e|copying|notice)(?:\..+)?$/i;

function fail(message) {
  throw new Error(message);
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, '\n');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatMetadataValue(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }

  if (Array.isArray(value) && value.length > 0) {
    return value.map(formatMetadataValue).join(' OR ');
  }

  if (value && typeof value === 'object') {
    if (typeof value.type === 'string' && value.type.trim() !== '') {
      return value.type.trim();
    }
    return JSON.stringify(value);
  }

  return '';
}

function packageSource(packageJson, lockEntry) {
  const repository = packageJson.repository;
  if (typeof repository === 'string' && repository.trim() !== '') {
    return repository.trim();
  }

  if (repository && typeof repository === 'object') {
    const repositoryUrl = formatMetadataValue(repository.url);
    if (repositoryUrl !== '') {
      const repositoryDirectory = formatMetadataValue(repository.directory);
      return repositoryDirectory === ''
        ? repositoryUrl
        : `${repositoryUrl} (directory: ${repositoryDirectory})`;
    }
  }

  const homepage = formatMetadataValue(packageJson.homepage);
  if (homepage !== '') {
    return homepage;
  }

  return formatMetadataValue(lockEntry.resolved);
}

function assertInsideNodeModules(packageDirectory, lockPath) {
  const relativePath = path.relative(nodeModulesDirectory, packageDirectory);
  if (
    relativePath === ''
    || relativePath.startsWith(`..${path.sep}`)
    || relativePath === '..'
    || path.isAbsolute(relativePath)
  ) {
    fail(`Unsafe package path in package-lock.json: ${lockPath}`);
  }
}

function requiredLicenseFilename(declaredLicense) {
  if (typeof declaredLicense !== 'string') {
    return null;
  }

  const match = declaredLicense.match(/^SEE LICEN[CS]E IN (.+)$/i);
  return match?.[1]?.trim() || null;
}

async function loadProductionPackages(lockfile) {
  if (lockfile.lockfileVersion !== 3 || !lockfile.packages) {
    fail('package-lock.json must use lockfileVersion 3 and contain a packages map.');
  }

  const packages = [];
  for (const [lockPath, lockEntry] of Object.entries(lockfile.packages)) {
    if (
      lockPath === ''
      || !lockPath.startsWith('node_modules/')
      || lockEntry.dev === true
    ) {
      continue;
    }

    const packageDirectory = path.resolve(frontendDirectory, ...lockPath.split('/'));
    assertInsideNodeModules(packageDirectory, lockPath);

    let packageJson;
    try {
      packageJson = JSON.parse(
        await readFile(path.join(packageDirectory, 'package.json'), 'utf8'),
      );
    } catch (error) {
      fail(`Missing or invalid installed package metadata for ${lockPath}: ${error.message}`);
    }

    const name = formatMetadataValue(packageJson.name);
    const version = formatMetadataValue(packageJson.version);
    if (name === '' || version === '') {
      fail(`Installed package ${lockPath} is missing its name or version.`);
    }
    if (version !== lockEntry.version) {
      fail(
        `Installed version mismatch for ${name}: lockfile has ${lockEntry.version}, `
        + `node_modules has ${version}. Run npm ci.`,
      );
    }

    const declaredLicense = formatMetadataValue(packageJson.license ?? lockEntry.license);
    if (declaredLicense === '') {
      fail(`Installed package ${name}@${version} has no declared license.`);
    }

    const source = packageSource(packageJson, lockEntry);
    if (source === '') {
      fail(`Installed package ${name}@${version} has no source URL.`);
    }

    let directoryEntries;
    try {
      directoryEntries = await readdir(packageDirectory, { withFileTypes: true });
    } catch (error) {
      fail(`Cannot inspect installed package ${name}@${version}: ${error.message}`);
    }

    const noticeFilenames = directoryEntries
      .filter((entry) => entry.isFile() && noticeFilePattern.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareText);

    const specificallyRequiredLicense = requiredLicenseFilename(packageJson.license);
    if (
      specificallyRequiredLicense
      && !noticeFilenames.some(
        (filename) => filename.toLowerCase() === specificallyRequiredLicense.toLowerCase(),
      )
    ) {
      fail(
        `${name}@${version} declares "${packageJson.license}", but `
        + `${specificallyRequiredLicense} is missing.`,
      );
    }

    if (noticeFilenames.length === 0) {
      fail(`Installed package ${name}@${version} has no LICENSE, COPYING, or NOTICE file.`);
    }

    const notices = [];
    for (const filename of noticeFilenames) {
      const noticeText = normalizeLineEndings(
        await readFile(path.join(packageDirectory, filename), 'utf8'),
      );
      if (noticeText.trim() === '') {
        fail(`Installed package ${name}@${version} has an empty ${filename} file.`);
      }
      notices.push({ filename, text: noticeText });
    }

    packages.push({
      declaredLicense,
      lockPath,
      name,
      notices,
      source,
      version,
    });
  }

  packages.sort((left, right) => (
    compareText(left.name, right.name)
    || compareText(left.version, right.version)
    || compareText(left.lockPath, right.lockPath)
  ));

  if (packages.length === 0) {
    fail('No production packages were found in package-lock.json.');
  }

  return packages;
}

function renderNotices(packages) {
  const separator = '='.repeat(80);
  const lines = [
    'OpenStudio Frontend Third-Party Notices',
    '',
    'This file is generated from frontend/package-lock.json and the exact license,',
    'copying, and notice files installed in frontend/node_modules. Do not edit it',
    'manually; run `npm run notices:generate` after changing production dependencies.',
    '',
    `Production package instances: ${packages.length}`,
  ];

  for (const packageInfo of packages) {
    lines.push(
      '',
      separator,
      `${packageInfo.name}@${packageInfo.version}`,
      `Installed path: ${packageInfo.lockPath}`,
      `Declared license: ${packageInfo.declaredLicense}`,
      `Source: ${packageInfo.source}`,
    );

    for (const notice of packageInfo.notices) {
      lines.push(
        '',
        `--- BEGIN ${notice.filename} (verbatim; line endings normalized to LF) ---`,
        notice.text,
        `--- END ${notice.filename} ---`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const checkOnly = argumentsList.length === 1 && argumentsList[0] === '--check';
  if (argumentsList.length > 0 && !checkOnly) {
    fail('Usage: node scripts/generate-third-party-notices.mjs [--check]');
  }

  const lockfile = JSON.parse(await readFile(lockfilePath, 'utf8'));
  const packages = await loadProductionPackages(lockfile);
  const generatedNotices = renderNotices(packages);

  if (checkOnly) {
    let committedNotices;
    try {
      committedNotices = normalizeLineEndings(await readFile(outputPath, 'utf8'));
    } catch (error) {
      fail(`Cannot read ${path.basename(outputPath)}: ${error.message}`);
    }

    if (committedNotices !== generatedNotices) {
      fail(
        `${path.basename(outputPath)} is stale. Run npm run notices:generate and commit the result.`,
      );
    }

    process.stdout.write(
      `${path.basename(outputPath)} is current (${packages.length} production package instances).\n`,
    );
    return;
  }

  await writeFile(outputPath, generatedNotices, 'utf8');
  process.stdout.write(
    `Wrote ${path.basename(outputPath)} (${packages.length} production package instances).\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`Third-party notice generation failed: ${error.message}\n`);
  process.exitCode = 1;
});
