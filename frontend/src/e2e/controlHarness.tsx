import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Slider } from '../components/ui/Slider';
import '../index.css';

function DisabledControl({ vertical }: { vertical: boolean }) {
  const label = vertical ? 'Disabled fader' : 'Disabled pan';
  const [value, setValue] = useState(25);
  const [begins, setBegins] = useState(0);
  const [commits, setCommits] = useState(0);
  return <section className="flex flex-col gap-4 p-6 w-64">
    <Slider aria-label={label} disabled value={value} min={-100} max={100}
      defaultValue={0} orientation={vertical ? 'vertical' : 'horizontal'}
      variant={vertical ? 'fader' : 'pan'} height={vertical ? '180px' : undefined}
      width={vertical ? '18px' : '180px'} onChange={setValue}
      onBeginEdit={() => setBegins((n) => n + 1)} onCommitEdit={() => setCommits((n) => n + 1)} />
    <output aria-label={`${label} value`}>{value}</output>
    <output aria-label={`${label} transactions`}>{begins}/{commits}</output>
  </section>;
}

createRoot(document.getElementById('root')!).render(
  <main className="flex gap-6 bg-daw-dark text-daw-text"><DisabledControl vertical={false} /><DisabledControl vertical /></main>,
);
