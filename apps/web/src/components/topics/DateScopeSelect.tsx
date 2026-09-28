import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Segmented, ConfigProvider, Input, Button, type InputRef } from 'antd';
import { CalendarOutlined, CheckOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { DateFilterScope } from '@mahalla-ovozi/api-contracts';
import { getTashkentToday } from '../../lib/formatters.js';

export interface DateScopeSelectProps {
  dateScope: DateFilterScope;
  dateFrom?: string;
  dateTo?: string;
  onChange: (scope: { dateScope: DateFilterScope; dateFrom?: string; dateTo?: string }) => void;
  disabled?: boolean;
}

const PRESETS: { label: string; days: number }[] = [
  { label: '7 кун', days: 7 },
  { label: '14 кун', days: 14 },
  { label: '30 кун', days: 30 },
];

export function parseDateInput(raw: string): Dayjs | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Match DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY (allowing 1 or 2 digits for day and month)
  const ddmmyyyyMatch = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (ddmmyyyyMatch) {
    const rawDay = ddmmyyyyMatch[1];
    const rawMonth = ddmmyyyyMatch[2];
    const rawYear = ddmmyyyyMatch[3];
    if (rawDay && rawMonth && rawYear) {
      const day = parseInt(rawDay, 10);
      const month = parseInt(rawMonth, 10);
      const year = parseInt(rawYear, 10);

      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      const jsDate = new Date(year, month - 1, day);
      if (
        jsDate.getFullYear() === year &&
        jsDate.getMonth() === month - 1 &&
        jsDate.getDate() === day
      ) {
        return dayjs(jsDate);
      }
      return null;
    }
  }

  // Match ISO format YYYY-MM-DD
  const ymdMatch = trimmed.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (ymdMatch) {
    const rawYear = ymdMatch[1];
    const rawMonth = ymdMatch[2];
    const rawDay = ymdMatch[3];
    if (rawYear && rawMonth && rawDay) {
      const year = parseInt(rawYear, 10);
      const month = parseInt(rawMonth, 10);
      const day = parseInt(rawDay, 10);

      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      const jsDate = new Date(year, month - 1, day);
      if (
        jsDate.getFullYear() === year &&
        jsDate.getMonth() === month - 1 &&
        jsDate.getDate() === day
      ) {
        return dayjs(jsDate);
      }
      return null;
    }
  }

  return null;
}

export const DateScopeSelect: React.FC<DateScopeSelectProps> = ({
  dateScope,
  dateFrom,
  dateTo,
  onChange,
  disabled = false,
}) => {
  const todayYmd = getTashkentToday();
  const ninetyDaysAgoYmd = dayjs(todayYmd, 'YYYY-MM-DD').subtract(90, 'day').format('YYYY-MM-DD');

  const defaultFromFormatted = dayjs(todayYmd, 'YYYY-MM-DD').subtract(6, 'day').format('DD.MM.YYYY');
  const defaultToFormatted = dayjs(todayYmd, 'YYYY-MM-DD').format('DD.MM.YYYY');

  const [isOpen, setIsOpen] = useState(false);
  const [manualFrom, setManualFrom] = useState(() => (dateFrom ? dayjs(dateFrom).format('DD.MM.YYYY') : defaultFromFormatted));
  const [manualTo, setManualTo] = useState(() => (dateTo ? dayjs(dateTo).format('DD.MM.YYYY') : defaultToFormatted));
  const [manualError, setManualError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const customBtnRef = useRef<HTMLSpanElement>(null);
  const toInputRef = useRef<InputRef>(null);
  const [overlayStyle, setOverlayStyle] = useState<React.CSSProperties>({
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    zIndex: 1050,
  });

  // Calculate centered overlay position relative to custom date button
  useEffect(() => {
    if (!isOpen) return;

    const calculatePosition = () => {
      const width = 270;
      if (!customBtnRef.current || !containerRef.current) {
        setOverlayStyle({
          position: 'absolute',
          top: 'calc(100% + 6px)',
          right: 0,
          width,
          zIndex: 1050,
        });
        return;
      }

      const customRect = customBtnRef.current.getBoundingClientRect();
      const containerRect = containerRef.current.getBoundingClientRect();
      const btnCenter = customRect.left + customRect.width / 2 - containerRect.left;

      let leftPos = btnCenter - width / 2;

      // Viewport collision avoidance
      if (typeof window !== 'undefined') {
        const viewportWidth = window.innerWidth;
        const overlayAbsRight = containerRect.left + leftPos + width;
        if (overlayAbsRight > viewportWidth - 16) {
          leftPos = viewportWidth - 16 - width - containerRect.left;
        }
        if (containerRect.left + leftPos < 16) {
          leftPos = 16 - containerRect.left;
        }
      }

      setOverlayStyle({
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: leftPos,
        width,
        zIndex: 1050,
      });
    };

    calculatePosition();
    window.addEventListener('resize', calculatePosition);
    return () => window.removeEventListener('resize', calculatePosition);
  }, [isOpen]);

  // Close overlay only when dateScope explicitly transitions away from 'custom' (e.g. external reset to 'today')
  const prevDateScopeRef = useRef(dateScope);
  useEffect(() => {
    if (prevDateScopeRef.current === 'custom' && dateScope !== 'custom') {
      setIsOpen(false);
    }
    prevDateScopeRef.current = dateScope;
  }, [dateScope]);

  // Sync inputs when external date bounds change
  useEffect(() => {
    if (dateFrom) {
      setManualFrom(dayjs(dateFrom).format('DD.MM.YYYY'));
    } else {
      const defaultFrom = dayjs(todayYmd, 'YYYY-MM-DD').subtract(6, 'day').format('DD.MM.YYYY');
      setManualFrom(defaultFrom);
    }
    if (dateTo) {
      setManualTo(dayjs(dateTo).format('DD.MM.YYYY'));
    } else {
      const defaultTo = dayjs(todayYmd, 'YYYY-MM-DD').format('DD.MM.YYYY');
      setManualTo(defaultTo);
    }
    setManualError(null);
  }, [dateFrom, dateTo, todayYmd]);

  // Close overlay on outside click or Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const applyManual = useCallback(() => {
    const from = parseDateInput(manualFrom);
    const to = parseDateInput(manualTo);

    if (!from || !to) {
      setManualError('Сана формати нотўғри (КК.ОО.ЙЙЙЙ)');
      return;
    }
    if (from.isAfter(to)) {
      setManualError('Бошланғич сана якуний санадан кейин бўлиши мумкин эмас');
      return;
    }

    const fromYmd = from.format('YYYY-MM-DD');
    const toYmd = to.format('YYYY-MM-DD');

    if (toYmd > todayYmd) {
      setManualError('Келгуси саналарни танлаш мумкин эмас');
      return;
    }
    if (fromYmd < ninetyDaysAgoYmd) {
      setManualError('Сўнгги 90 кундан олдинги саналарни танлаш мумкин эмас');
      return;
    }

    setManualError(null);
    onChange({ dateScope: 'custom', dateFrom: fromYmd, dateTo: toYmd });
    setIsOpen(false);
  }, [manualFrom, manualTo, todayYmd, ninetyDaysAgoYmd, onChange]);

  // Determine if current manual inputs match a quick preset (updates button highlight immediately)
  const activePresetDays = (() => {
    const from = parseDateInput(manualFrom);
    const to = parseDateInput(manualTo);
    if (!from || !to) return null;
    const fromYmd = from.format('YYYY-MM-DD');
    const toYmd = to.format('YYYY-MM-DD');
    if (toYmd !== todayYmd) return null;

    for (const { days } of PRESETS) {
      const expectedFrom = dayjs(todayYmd, 'YYYY-MM-DD').subtract(days - 1, 'day').format('YYYY-MM-DD');
      if (fromYmd === expectedFrom) {
        return days;
      }
    }
    return null;
  })();

  const isDirty = (() => {
    const currentAppliedFrom = dateFrom ? dayjs(dateFrom).format('DD.MM.YYYY') : defaultFromFormatted;
    const currentAppliedTo = dateTo ? dayjs(dateTo).format('DD.MM.YYYY') : defaultToFormatted;
    return manualFrom.trim() !== currentAppliedFrom || manualTo.trim() !== currentAppliedTo;
  })();

  const applyPreset = useCallback(
    (days: number) => {
      const today = dayjs(todayYmd, 'YYYY-MM-DD');
      const from = today.subtract(days - 1, 'day');

      setManualFrom(from.format('DD.MM.YYYY'));
      setManualTo(today.format('DD.MM.YYYY'));
      setManualError(null);
    },
    [todayYmd],
  );

  const handleScopeChange = (value: string | number) => {
    const scope = value as DateFilterScope;
    if (scope === 'today') {
      setIsOpen(false);
      onChange({ dateScope: 'today' });
    } else if (scope === 'yesterday') {
      setIsOpen(false);
      onChange({ dateScope: 'yesterday' });
    } else if (scope === 'custom') {
      // If already on custom, toggle overlay; otherwise open and seed defaults
      if (dateScope === 'custom') {
        setIsOpen((prev) => !prev);
      } else {
        const defaultFrom = dateFrom || dayjs(todayYmd, 'YYYY-MM-DD').subtract(6, 'day').format('YYYY-MM-DD');
        const defaultTo = dateTo || todayYmd;
        setManualFrom(dayjs(defaultFrom).format('DD.MM.YYYY'));
        setManualTo(dayjs(defaultTo).format('DD.MM.YYYY'));
        setManualError(null);
        onChange({ dateScope: 'custom', dateFrom: defaultFrom, dateTo: defaultTo });
        setIsOpen(true);
      }
    }
  };

  const customLabel = (
    <span
      ref={customBtnRef}
      onClick={(e) => {
        if (disabled) return;
        if (dateScope === 'custom') {
          e.stopPropagation();
          setIsOpen((prev) => !prev);
        }
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        width: '100%',
        height: '100%',
        margin: '-2px -8px',
        padding: '2px 8px',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <CalendarOutlined />
      {dateScope === 'custom' && dateFrom && dateTo
        ? dateFrom === dateTo
          ? dayjs(dateFrom).format('DD.MM')
          : `${dayjs(dateFrom).format('DD.MM')} – ${dayjs(dateTo).format('DD.MM')}`
        : 'Сана бўйича'}
    </span>
  );

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <ConfigProvider
        theme={{
          token: {
            controlHeight: 32,
            fontSize: 14,
            borderRadius: 6,
            borderRadiusSM: 4,
          },
          components: {
            Segmented: {
              controlHeight: 32,
              trackPadding: 2,
              trackBg: '#F8FAFC',
              itemSelectedBg: '#FFFFFF',
              itemSelectedColor: '#0F172A',
              itemColor: '#64748B',
              itemHoverColor: '#0F172A',
              borderRadius: 6,
              borderRadiusSM: 4,
            },
          },
        }}
      >
        <Segmented
          value={dateScope}
          onChange={handleScopeChange}
          disabled={disabled}
          options={[
            { label: 'Бугун', value: 'today' },
            { label: 'Кеча', value: 'yesterday' },
            { label: customLabel, value: 'custom' },
          ]}
          style={{
            border: '1px solid #E2E8F0',
            borderRadius: 6,
            boxSizing: 'border-box',
            fontWeight: 400,
            fontSize: 14,
            flexShrink: 0,
          }}
        />
      </ConfigProvider>

      {/* Custom date range overlay — responsive 2-row design centered on custom date button */}
      {isOpen && (
        <div
          role="dialog"
          aria-label="Сана оралиғини танлаш"
          style={{
            ...overlayStyle,
            backgroundColor: '#FFFFFF',
            border: '1px solid #E2E8F0',
            borderRadius: 8,
            boxShadow: '0 6px 16px 0 rgba(0,0,0,0.08), 0 3px 6px -4px rgba(0,0,0,0.12)',
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {/* Row 1: Date inputs */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
            <Input
              placeholder="КК.ОО.ЙЙЙЙ"
              value={manualFrom}
              onChange={(e) => {
                setManualFrom(e.target.value);
                setManualError(null);
              }}
              onPressEnter={() => toInputRef.current?.focus()}
              status={manualError ? 'error' : undefined}
              style={{ flex: 1, minWidth: 0, height: 30, fontSize: 12, borderRadius: 4 }}
              aria-label="Бошланғич санани қўлда киритиш"
            />
            <span style={{ color: '#94A3B8', fontSize: 13, flexShrink: 0 }}>—</span>
            <Input
              ref={toInputRef}
              placeholder="КК.ОО.ЙЙЙЙ"
              value={manualTo}
              onChange={(e) => {
                setManualTo(e.target.value);
                setManualError(null);
              }}
              onPressEnter={applyManual}
              status={manualError ? 'error' : undefined}
              style={{ flex: 1, minWidth: 0, height: 30, fontSize: 12, borderRadius: 4 }}
              aria-label="Якуний санани қўлда киритиш"
            />
          </div>

          {/* Row 2: Presets + Apply */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 4,
              width: '100%',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {PRESETS.map(({ label, days }) => {
                const isActive = activePresetDays === days;
                return (
                  <Button
                    key={days}
                    size="small"
                    onClick={() => applyPreset(days)}
                    style={{
                      height: 28,
                      fontSize: 12,
                      borderRadius: 4,
                      padding: '0 8px',
                      fontWeight: isActive ? 600 : 400,
                      color: isActive ? '#0284C7' : '#475569',
                      borderColor: isActive ? '#0284C7' : '#CBD5E1',
                      backgroundColor: isActive ? '#F0F9FF' : '#F8FAFC',
                    }}
                  >
                    {label}
                  </Button>
                );
              })}
            </div>

            <Button
              type="primary"
              size="small"
              disabled={!isDirty}
              icon={<CheckOutlined style={{ fontSize: 11 }} />}
              onClick={applyManual}
              style={{
                height: 28,
                fontSize: 12,
                borderRadius: 4,
                padding: '0 10px',
                fontWeight: 500,
                flexShrink: 0,
                backgroundColor: isDirty ? '#0284C7' : undefined,
              }}
              aria-label="Киритилган саналарни қўллаш"
            >
              Қўллаш
            </Button>
          </div>

          {/* Validation error */}
          {manualError && (
            <div
              style={{
                padding: '4px 6px',
                backgroundColor: '#FEF2F2',
                color: '#DC2626',
                fontSize: 11,
                borderRadius: 4,
                border: '1px solid #FECACA',
              }}
            >
              {manualError}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
