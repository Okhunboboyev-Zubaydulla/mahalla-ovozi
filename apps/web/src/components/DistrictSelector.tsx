import React, { useMemo } from 'react';
import { Select, Divider, Button } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { districtClient } from '../district/district-client.js';
import { useDistrict } from '../district/district-context.js';
import { themeColors } from '../theme/antd-theme.js';

interface DistrictSelectorProps {
  onOpenCreateDrawer?: () => void;
}

export const DistrictSelector: React.FC<DistrictSelectorProps> = ({ onOpenCreateDrawer }) => {
  const { activeDistrictId, switchDistrict, setActiveDistrictDirectly } = useDistrict();

  const { data, isLoading } = useQuery({
    queryKey: ['districts', 'list'],
    queryFn: districtClient.listDistricts,
  });

  const districts = data?.districts || [];

  const options = useMemo(
    () =>
      districts.map((d) => ({
        value: d.id,
        label: d.region ? `${d.name} (${d.region})` : d.name,
      })),
    [districts]
  );

  const handleChange = (value: string | undefined) => {
    if (value) {
      void switchDistrict(value);
    } else {
      setActiveDistrictDirectly(null);
    }
  };

  const renderDropdown = (menu: React.ReactNode) => (
    <>
      {menu}
      {onOpenCreateDrawer && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <div style={{ padding: '0 8px 4px' }}>
            <Button
              id="district-selector-add-button"
              type="text"
              icon={<PlusOutlined />}
              block
              onClick={onOpenCreateDrawer}
              style={{ textAlign: 'left', fontWeight: 500, color: themeColors.colorPrimary }}
            >
              Туман қўшиш
            </Button>
          </div>
        </>
      )}
    </>
  );

  return (
    <Select
      id="district-selector"
      showSearch
      allowClear
      loading={isLoading}
      placeholder="Туманни танланг"
      optionFilterProp="label"
      value={activeDistrictId || undefined}
      onChange={handleChange}
      options={options}
      style={{ width: 240 }}
      popupRender={renderDropdown}
    />
  );
};
