import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Input, ConfigProvider } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

export interface DashboardSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  onSearch?: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  className?: string;
  disabled?: boolean;
}

export const DashboardSearchInput: React.FC<DashboardSearchInputProps> = ({
  value,
  onChange,
  onSearch,
  placeholder = 'Мавзу ёки далил бўйича қидирув...',
  style,
  className,
  disabled = false,
}) => {
  const [localValue, setLocalValue] = useState(value);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Synchronize local input state if external value changes (e.g., reset)
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setLocalValue(value);
  }, [value]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const triggerChange = useCallback(
    (newValue: string) => {
      onChange(newValue);
      onSearch?.(newValue);
    },
    [onChange, onSearch],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextVal = e.target.value;
    setLocalValue(nextVal);

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    if (!nextVal.trim()) {
      // Clear immediately when input is emptied
      triggerChange('');
      return;
    }

    debounceTimerRef.current = setTimeout(() => {
      triggerChange(nextVal);
    }, 400);
  };

  const handlePressEnter = () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    triggerChange(localValue);
  };

  return (
    <ConfigProvider
      theme={{
        components: {
          Input: {
            colorText: '#64748B',
            colorTextPlaceholder: '#64748B',
            colorBorder: '#CBD5E1',
            hoverBorderColor: '#0284C7',
            activeBorderColor: '#0284C7',
            activeShadow: '0 0 0 2px rgba(2, 132, 199, 0.2)',
            fontSize: 14,
            controlHeight: 32,
            borderRadius: 6,
          },
        },
      }}
    >
      <Input
        className={className}
        type="search"
        role="searchbox"
        value={localValue}
        onChange={handleChange}
        onPressEnter={handlePressEnter}
        placeholder={placeholder}
        prefix={<SearchOutlined style={{ color: '#64748B', fontSize: 14 }} />}
        allowClear
        maxLength={200}
        disabled={disabled}
        aria-label="Мавзулар ва далиллар бўйича қидирув"
        styles={{
          input: {
            fontSize: 14,
            fontWeight: 400,
            lineHeight: '22px',
            color: '#64748B',
          },
        }}
        style={{
          width: 300,
          borderRadius: 6,
          borderColor: '#CBD5E1',
          height: 32,
          backgroundColor: '#FFFFFF',
          fontSize: 14,
          fontWeight: 400,
          color: '#64748B',
          padding: '0 8px',
          display: 'inline-flex',
          alignItems: 'center',
          flexShrink: 0,
          ...style,
        }}
      />
    </ConfigProvider>
  );
};
