import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { fontFamilies } from '../core/fonts';

export function FontPicker({
  value,
  fonts,
  onChange,
  onReadLocalFonts,
  status,
}: {
  value: string;
  fonts: string[];
  onChange: (value: string) => void;
  onReadLocalFonts: () => void;
  status: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const id = useId();
  const families = fontFamilies([...fonts, value]);
  const filtered = families.filter((family) =>
    family.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <div
      className="field font-picker"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpen(false);
          event.stopPropagation();
        }
      }}
    >
      <label htmlFor={id}>字体</label>
      <div className="font-picker-current">
        <input
          id={id}
          aria-label="字体"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="icon-button"
          aria-label="展开字体列表"
          aria-expanded={open}
          aria-controls={`${id}-choices`}
          onClick={() => {
            setSearch('');
            setOpen(!open);
          }}
        >
          <ChevronDown size={16} />
        </button>
      </div>
      {open && (
        <div id={`${id}-choices`} className="font-picker-choices">
          <input
            autoFocus
            type="search"
            aria-label="搜索字体"
            placeholder="搜索字体名称…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <span className="font-picker-count">
            {filtered.length} / {families.length} 个字体
          </span>
          {filtered.length ? (
            <select
              size={8}
              aria-label="可用字体"
              value={filtered.includes(value) ? value : ''}
              onChange={(event) => {
                onChange(event.target.value);
                setOpen(false);
              }}
            >
              {filtered.map((family) => (
                <option key={family} value={family}>
                  {family}
                </option>
              ))}
            </select>
          ) : (
            <p className="hint">没有匹配的字体。也可在上方直接输入字体名称。</p>
          )}
          <button type="button" className="secondary full" onClick={onReadLocalFonts}>
            读取本机字体
          </button>
          <p className="hint">{status}</p>
        </div>
      )}
    </div>
  );
}
