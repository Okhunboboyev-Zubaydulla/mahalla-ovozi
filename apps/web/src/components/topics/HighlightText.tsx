import React, { useMemo } from 'react';

export interface HighlightTextProps {
  text: string;
  searchQuery?: string;
  style?: React.CSSProperties;
}

export const HighlightText: React.FC<HighlightTextProps> = ({
  text,
  searchQuery,
  style,
}) => {
  const safeText = typeof text === 'string' ? text : '';
  const query = searchQuery?.trim() || '';

  const parts = useMemo(() => {
    if (!query || !safeText) return null;
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedQuery})`, 'gi');
    return safeText.split(regex);
  }, [safeText, query]);

  if (!text || typeof text !== 'string') {
    return <span style={style}>{text ?? ''}</span>;
  }

  if (!parts || !query) {
    return <span style={style}>{text}</span>;
  }

  const normalizedQuery = query.normalize('NFC').toLowerCase();

  return (
    <span style={style}>
      {parts.map((part, index) => {
        const isMatch = part.normalize('NFC').toLowerCase() === normalizedQuery;
        if (isMatch) {
          return (
            <mark
              key={index}
              style={{
                backgroundColor: '#F5DD77',
                color: '#0F172A',
                padding: '0 2px',
                borderRadius: 2,
                fontStyle: 'inherit',
                fontWeight: 'inherit',
              }}
            >
              {part}
            </mark>
          );
        }
        return <React.Fragment key={index}>{part}</React.Fragment>;
      })}
    </span>
  );
};
