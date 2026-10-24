import { useId } from 'react';
import { FRAME_RATE_HINT, FRAME_RATE_PRESETS, MAX_FRAME_RATE, MIN_FRAME_RATE } from './settings';

export function FrameRateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (fps: number) => void;
}) {
  const id = useId();
  return (
    <>
      <input
        type="number"
        aria-label={label}
        title={FRAME_RATE_HINT}
        min={MIN_FRAME_RATE}
        max={MAX_FRAME_RATE}
        step="any"
        list={id}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <datalist id={id}>
        {FRAME_RATE_PRESETS.map((fps) => (
          <option key={fps} value={fps} />
        ))}
      </datalist>
    </>
  );
}
