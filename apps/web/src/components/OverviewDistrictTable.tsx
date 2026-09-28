import React, { useState, useMemo } from 'react';
import {
  Card,
  Table,
  Typography,
  Tag,
  Button,
  Segmented,
  Empty,
  Space,
  theme,
} from 'antd';
import {
  PlusOutlined,
  CheckCircleOutlined,
  SettingOutlined,
  EyeOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { District } from '@mahalla-ovozi/api-contracts';
import { useDistrict } from '../district/district-context.js';
import { formatTashkentDate } from '../lib/formatters.js';

const { Title, Text } = Typography;

interface OverviewDistrictTableProps {
  districts: District[];
  loading?: boolean;
  onOpenCreateDrawer: () => void;
  onSelectDistrictForFocus?: (districtId: string) => void;
  onEditDistrict?: (district: District) => void;
}

type FilterStatus = 'ALL' | 'ACTIVE' | 'SETUP_INCOMPLETE';

export const OverviewDistrictTable: React.FC<OverviewDistrictTableProps> = ({
  districts,
  loading = false,
  onOpenCreateDrawer,
  onSelectDistrictForFocus,
  onEditDistrict,
}) => {
  const { token } = theme.useToken();
  const { activeDistrictId, switchDistrict, attemptTransition } = useDistrict();
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('ALL');

  const activeCount = useMemo(
    () => districts.filter((d) => d.status === 'ACTIVE').length,
    [districts]
  );
  const incompleteCount = useMemo(
    () => districts.filter((d) => d.status === 'SETUP_INCOMPLETE').length,
    [districts]
  );

  const filteredDistricts = useMemo(() => {
    if (filterStatus === 'ACTIVE') {
      return districts.filter((d) => d.status === 'ACTIVE');
    }
    if (filterStatus === 'SETUP_INCOMPLETE') {
      return districts.filter((d) => d.status === 'SETUP_INCOMPLETE');
    }
    return districts;
  }, [districts, filterStatus]);

  const handleSwitchAndFocus = (districtId: string) => {
    attemptTransition(async () => {
      if (activeDistrictId !== districtId) {
        await switchDistrict(districtId);
      }
      if (onSelectDistrictForFocus) {
        onSelectDistrictForFocus(districtId);
      }
    });
  };

  const columns = useMemo(
    () => [
      {
        title: 'Туман номи',
        dataIndex: 'name',
        key: 'name',
        render: (name: string, record: District) => (
          <Space direction="vertical" size={2}>
            <Text strong style={{ fontSize: 14 }}>
              {name}
            </Text>
            {record.region && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {record.region}
              </Text>
            )}
          </Space>
        ),
      },
      {
        title: 'Ҳолати',
        dataIndex: 'status',
        key: 'status',
        render: (status: string) => {
          if (status === 'ACTIVE') {
            return (
              <Tag color="success" icon={<CheckCircleOutlined />}>
                Фаол
              </Tag>
            );
          }
          if (status === 'SETUP_INCOMPLETE') {
            return <Tag color="warning">Созлаш тугалланмаган</Tag>;
          }
          if (status === 'SUSPENDED') {
            return <Tag color="error">Тўхтатилган</Tag>;
          }
          return <Tag color="default">{status}</Tag>;
        },
      },
      {
        title: 'Яратилган вақти',
        dataIndex: 'createdAt',
        key: 'createdAt',
        render: (createdAt: string) => (
          <Text type="secondary" style={{ fontSize: 13 }}>
            {formatTashkentDate(createdAt)}
          </Text>
        ),
      },
      {
        title: 'Амаллар',
        key: 'actions',
        render: (_: unknown, record: District) => {
          const isSelected = activeDistrictId === record.id;
          return (
            <Space direction="horizontal" size="middle" align="center">
              {isSelected ? (
                <Tag color="cyan" icon={<CheckCircleOutlined />}>
                  Танланган
                </Tag>
              ) : (
                <Button
                  type="link"
                  aria-label={`Танлаш: ${record.name}`}
                  onClick={() => handleSwitchAndFocus(record.id)}
                  style={{ minHeight: 44, padding: '0 8px', display: 'inline-flex', alignItems: 'center' }}
                >
                  Танлаш
                </Button>
              )}

              {onEditDistrict && (
                <Button
                  type="link"
                  icon={<EditOutlined />}
                  aria-label={`Таҳрирлаш: ${record.name}`}
                  onClick={() => onEditDistrict(record)}
                  style={{ minHeight: 44, padding: '0 8px', display: 'inline-flex', alignItems: 'center' }}
                >
                  Таҳрирлаш
                </Button>
              )}

              <Button
                type="link"
                icon={record.status === 'SETUP_INCOMPLETE' ? <SettingOutlined /> : <EyeOutlined />}
                aria-label={record.status === 'SETUP_INCOMPLETE' ? `Созлаш: ${record.name}` : `Кўриш: ${record.name}`}
                onClick={() => handleSwitchAndFocus(record.id)}
                style={{ minHeight: 44, padding: '0 8px', display: 'inline-flex', alignItems: 'center' }}
              >
                {record.status === 'SETUP_INCOMPLETE' ? 'Созлаш' : 'Кўриш'}
              </Button>
            </Space>
          );
        },
      },
    ],
    [activeDistrictId, handleSwitchAndFocus, onEditDistrict]
  );

  return (
    <Card
      variant="borderless"
      style={{
        borderRadius: 12,
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary || '#E2EAE7'}`,
      }}
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, padding: '8px 0' }}>
          <div>
            <Title level={4} style={{ margin: 0, fontSize: 16 }}>
              Туманлар рўйхати
            </Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              Тизимдаги барча туманлар ва созлаш ҳолатлари
            </Text>
          </div>

          <Space direction="horizontal" size="middle" wrap>
            <Segmented<FilterStatus>
              value={filterStatus}
              onChange={(val) => setFilterStatus(val)}
              options={[
                { label: `Барчаси (${districts.length})`, value: 'ALL' },
                { label: `Фаол (${activeCount})`, value: 'ACTIVE' },
                { label: `Созланмоқда (${incompleteCount})`, value: 'SETUP_INCOMPLETE' },
              ]}
              style={{ minHeight: 36 }}
            />

            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={onOpenCreateDrawer}
              style={{ minHeight: 40 }}
            >
              Янги туман қўшиш
            </Button>
          </Space>
        </div>
      }
    >
      {filteredDistricts.length === 0 && !loading ? (
        <div style={{ padding: '32px 0', textAlign: 'center' }}>
          <Empty
            description={
              filterStatus === 'ALL'
                ? 'Ҳозирча тизимда туманлар мавжуд эмас.'
                : 'Танланган филтр бўйича туманлар топилмади.'
            }
          >
            {filterStatus === 'ALL' ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={onOpenCreateDrawer} style={{ minHeight: 44 }}>
                Биринчи туманни қўшиш
              </Button>
            ) : (
              <Button onClick={() => setFilterStatus('ALL')} style={{ minHeight: 44 }}>
                Филтрни тозалаш
              </Button>
            )}
          </Empty>
        </div>
      ) : (
        <Table<District>
          rowKey="id"
          columns={columns}
          dataSource={filteredDistricts}
          loading={loading}
          pagination={filteredDistricts.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
          style={{ overflowX: 'auto' }}
        />
      )}
    </Card>
  );
};
