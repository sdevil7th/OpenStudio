"""Release gate for the separate offline support payload; does not launch it."""
import argparse
from pathlib import Path


from support_package import validate


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    print(f'Validated {validate(args.bundle, args.version)} offline support files (tool was not launched).')
