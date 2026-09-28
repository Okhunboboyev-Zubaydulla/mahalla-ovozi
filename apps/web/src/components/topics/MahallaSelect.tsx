import React from 'react';
import { Select, ConfigProvider } from 'antd';
import { EnvironmentOutlined } from '@ant-design/icons';
import { useDistrictMahallas } from '../../topics/useDistrictMahallas.js';

export interface MahallaSelectProps {
  value?: string;
  onChange: (mahallaName?: string) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}

export const MahallaSelect: React.FC<MahallaSelectProps> = ({
  value,
  onChange,
  disabled = false,
  style,
}) => {
  const { mahallas, isLoading } = useDistrictMahallas();

  const options = [
    { label: 'Барча маҳаллалар', value: 'all' },
    ...mahallas.map((name) => ({ label: name, value: name })),
  ];

  const selectedValue = value && value !== 'all' ? value : 'all';

  return (
    <ConfigProvider
      theme={{
        token: {
          controlOutline: 'rgba(2, 132, 199, 0.2)',
          controlOutlineWidth: 2,
        },
        components: {
          Select: {
            colorText: '#64748B',
            colorTextPlaceholder: '#64748B',
            fontSize: 14,
            controlHeight: 32,
            borderRadius: 6,
            colorBorder: '#CBD5E1',
            hoverBorderColor: '#CBD5E1',
            activeBorderColor: '#CBD5E1',
            activeOutlineColor: 'rgba(2, 132, 199, 0.2)',
          },
        },
      }}
    >
      <Select
        showSearch
        value={selectedValue}
        onChange={(val) => {
          onChange(val === 'all' ? undefined : val);
        }}
        options={options}
        loading={isLoading}
        disabled={disabled}
        placeholder="Маҳаллани танланг"
        suffixIcon={<EnvironmentOutlined style={{ color: '#64748B' }} />}
        filterOption={(input, option) =>
          (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
        }
        style={{
          width: 180,
          fontWeight: 400,
          flexShrink: 0,
          ...style,
        }}
        aria-label="Маҳалла бўйича фильтр"
      />
    </ConfigProvider>
  );
};
