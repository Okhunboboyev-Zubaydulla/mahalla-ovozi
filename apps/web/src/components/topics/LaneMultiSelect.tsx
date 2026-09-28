import React, { useState } from 'react';
import { Button, Checkbox, Popover, Space, Typography, Tag, ConfigProvider } from 'antd';
import { DownOutlined, AppstoreOutlined } from '@ant-design/icons';
import { QualifyingLane, CANONICAL_LANES } from '@mahalla-ovozi/api-contracts';
import { LANE_LABELS, LANE_STYLES } from './TopicCard.js';

const { Text } = Typography;

export interface LaneMultiSelectProps {
  value: QualifyingLane[];
  onChange: (lanes: QualifyingLane[]) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}

export const LaneMultiSelect: React.FC<LaneMultiSelectProps> = ({
  value,
  onChange,
  disabled = false,
  style,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const selectedLanes = value && value.length > 0 ? value : CANONICAL_LANES;

  const handleToggleLane = (lane: QualifyingLane, checked: boolean) => {
    if (checked) {
      const nextLanes = CANONICAL_LANES.filter((l) => selectedLanes.includes(l) || l === lane);
      onChange(nextLanes);
    } else {
      // Non-zero invariant: cannot uncheck if only 1 lane remains
      if (selectedLanes.length <= 1) {
        return;
      }
      const nextLanes = CANONICAL_LANES.filter((l) => selectedLanes.includes(l) && l !== lane);
      onChange(nextLanes);
    }
  };

  const handleSelectAll = () => {
    onChange([...CANONICAL_LANES]);
  };

  const content = (
    <div style={{ width: 220, padding: '4px 0' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingBottom: 8,
          marginBottom: 8,
          borderBottom: '1px solid #F1F5F9',
        }}
      >
        <Text strong style={{ fontSize: 13, color: '#334155' }}>
          Йўналишларни танлаш
        </Text>
        {selectedLanes.length < CANONICAL_LANES.length && (
          <Button
            type="link"
            size="small"
            onClick={handleSelectAll}
            style={{ padding: '4px 8px', fontSize: 12, height: 'auto', color: '#0284C7' }}
          >
            Барчасини кўрсатиш
          </Button>
        )}
      </div>

      <Space direction="vertical" style={{ width: '100%' }} size={6}>
        {CANONICAL_LANES.map((lane) => {
          const isChecked = selectedLanes.includes(lane);
          const isSoleLane = isChecked && selectedLanes.length === 1;
          const styleConfig = LANE_STYLES[lane];

          return (
            <div
              key={lane}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 6px',
                borderRadius: 6,
                backgroundColor: isChecked ? '#F8FAFC' : 'transparent',
              }}
            >
              <Checkbox
                checked={isChecked}
                disabled={disabled || isSoleLane}
                onChange={(e) => handleToggleLane(lane, e.target.checked)}
                aria-label={LANE_LABELS[lane]}
              >
                <Tag
                  style={{
                    backgroundColor: styleConfig.bg,
                    color: styleConfig.text,
                    borderColor: styleConfig.border,
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: 600,
                    marginRight: 0,
                  }}
                >
                  {LANE_LABELS[lane]}
                </Tag>
              </Checkbox>
            </div>
          );
        })}
      </Space>
    </div>
  );

  return (
    <ConfigProvider
      theme={{
        token: {
          controlOutline: 'rgba(2, 132, 199, 0.2)',
          controlOutlineWidth: 2,
        },
        components: {
          Button: {
            colorText: '#64748B',
            defaultBorderColor: '#CBD5E1',
            defaultHoverBorderColor: '#0284C7',
            defaultActiveBorderColor: '#CBD5E1',
            borderRadius: 6,
            controlHeight: 32,
          },
        },
      }}
    >
      <Popover
        content={content}
        trigger="click"
        placement="bottomLeft"
        arrow={false}
        open={isOpen}
        onOpenChange={setIsOpen}
        styles={{
          body: {
            borderRadius: 8,
            boxShadow: 'none',
            border: '1px solid #E2E8F0',
          },
        }}
      >
        <Button
          disabled={disabled}
          icon={<AppstoreOutlined style={{ color: '#64748B', fontSize: 14 }} />}
          style={{
            height: 32,
            borderRadius: 6,
            borderColor: '#CBD5E1',
            boxShadow: isOpen ? '0 0 0 2px rgba(2, 132, 199, 0.2)' : undefined,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontWeight: 400,
            fontSize: 14,
            color: '#64748B',
            flexShrink: 0,
            ...style,
          }}
          aria-label={`Йўналишлар фильтри: ${selectedLanes.length} та йўналиш танланган`}
        >
          <span style={{ fontSize: 14, fontWeight: 400, color: '#64748B' }}>
            Йўналишлар: {selectedLanes.length}/5
          </span>
          <DownOutlined style={{ fontSize: 12, color: '#64748B' }} />
        </Button>
      </Popover>
    </ConfigProvider>
  );
};
