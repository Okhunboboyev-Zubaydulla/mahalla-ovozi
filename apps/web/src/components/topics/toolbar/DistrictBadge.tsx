import React from 'react';
import { Tooltip, Typography } from 'antd';
import { EnvironmentOutlined } from '@ant-design/icons';

const { Text } = Typography;

export interface DistrictBadgeProps {
  districtName: string;
  isPhone: boolean;
}

export const DistrictBadge: React.FC<DistrictBadgeProps> = ({
  districtName,
  isPhone,
}) => {
  const formattedDistrictName = districtName.toLowerCase().includes('туман')
    ? districtName
    : `${districtName} тумани`;
  const mobileDistrictName = districtName.replace(/\s*тумани\s*$/i, '');

  return (
    <Tooltip title={formattedDistrictName} placement="bottom">
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          backgroundColor: '#F8FAFC',
          border: '1px solid #E2E8F0',
          borderRadius: 6,
          height: 32,
          padding: '0 10px',
          maxWidth: isPhone ? 150 : 260,
          boxSizing: 'border-box',
        }}
      >
        <Text
          strong
          style={{
            fontSize: isPhone ? 13 : 14,
            color: '#0F172A',
            display: 'flex',
            alignItems: 'center',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            width: '100%',
          }}
        >
          <EnvironmentOutlined
            style={{
              color: '#0284C7',
              fontSize: isPhone ? 13 : 14,
              marginRight: isPhone ? 4 : 6,
              flexShrink: 0,
            }}
          />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {isPhone ? mobileDistrictName : formattedDistrictName}
          </span>
        </Text>
      </div>
    </Tooltip>
  );
};
