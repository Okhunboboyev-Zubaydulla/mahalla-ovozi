import React, { useState, useEffect } from 'react';
import { Typography, Grid, Tooltip } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';
import { formatTashkentLiveDateTime, type TashkentLiveDateTime } from '../../../lib/formatters.js';

const { Text } = Typography;
const { useBreakpoint } = Grid;

export const LiveClock: React.FC = () => {
  const screens = useBreakpoint();
  const isWide = screens.xl ?? true;
  const [formatted, setFormatted] = useState<TashkentLiveDateTime>(() =>
    formatTashkentLiveDateTime(new Date()),
  );

  useEffect(() => {
    const updateTime = () => {
      setFormatted(formatTashkentLiveDateTime(new Date()));
    };
    const timer = setInterval(updateTime, 10000);
    return () => clearInterval(timer);
  }, []);

  const displayText = isWide ? formatted.display : formatted.compact;

  return (
    <Tooltip title={`Ҳозирги вақт: ${formatted.full}`} placement="bottom">
      <div
        role="timer"
        aria-label={`Ҳозирги вақт: ${displayText}`}
        style={{
          height: 32,
          padding: '0 10px',
          backgroundColor: '#F8FAFC',
          border: '1px solid #E2E8F0',
          borderRadius: 6,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          userSelect: 'none',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        <ClockCircleOutlined style={{ color: '#0284C7', fontSize: 13 }} />
        <Text
          style={{
            fontSize: 13,
            color: '#334155',
            fontWeight: 500,
            whiteSpace: 'nowrap',
          }}
        >
          {displayText}
        </Text>
      </div>
    </Tooltip>
  );
};
