'use client';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import { inputClass } from '@/components/ui/field-styles';
import { interpolate } from '@/i18n';
import { studentText } from '@/i18n/student';
import { cn } from '@/lib/cn';
import { countries, searchCountries } from './countries';

/**
 * Searchable nationality select with flags (design §6.2). ARIA 1.2 combobox:
 * type to filter, arrow keys to move, Enter to choose, Escape to close.
 */
export function NationalitySelect({
  value,
  onChange,
  error,
}: {
  value: string | null;
  onChange: (code: string) => void;
  error?: string;
}) {
  const t = studentText.profile;
  const id = useId();
  const listId = `${id}-list`;
  const errId = `${id}-err`;
  const all = useMemo(() => countries(), []);
  const selected = value ? all.find((c) => c.code === value) ?? null : null;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchCountries(all, query).slice(0, 60), [all, query]);

  function choose(code: string) {
    onChange(code);
    setQuery('');
    setOpen(false);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      if (open && results[active]) {
        e.preventDefault();
        choose(results[active].code);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold">
        {t.nationality}
      </label>
      {selected && !open && (
        <div className="flex items-center justify-between gap-3 rounded-sm border border-line bg-surface p-3">
          <span className="flex items-center gap-2 text-base">
            <span aria-hidden className="text-2xl leading-none">
              {selected.flag}
            </span>
            {selected.name}
          </span>
          <button
            type="button"
            className="min-h-12 rounded-sm px-3 font-semibold text-link hover:bg-brand-100"
            onClick={() => {
              setOpen(true);
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
          >
            {t.nationalityChange}
            <span className="sr-only"> {t.nationality}</span>
          </button>
        </div>
      )}
      <div className={cn('relative', selected && !open && 'sr-only')}>
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted" />
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && results[active] ? `${id}-opt-${results[active].code}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          placeholder={t.nationalityPlaceholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKey}
          className={cn(inputClass, 'pl-9')}
        />
        {open && (
          <ul id={listId} role="listbox" aria-label={t.nationalitySearch} className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-sm border border-line bg-surface shadow-1">
            {results.length === 0 && <li className="p-3 text-sm text-ink-muted">{interpolate(t.nationalityNone, { q: query })}</li>}
            {results.map((c, i) => (
              <li
                key={c.code}
                id={`${id}-opt-${c.code}`}
                role="option"
                aria-selected={c.code === value}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(c.code)}
                className={cn('flex min-h-12 cursor-pointer items-center gap-3 px-3', i === active && 'bg-brand-100', c.code === value && 'font-semibold')}
              >
                <span aria-hidden className="text-xl leading-none">
                  {c.flag}
                </span>
                {c.name}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p id={errId} className="text-sm font-medium text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
