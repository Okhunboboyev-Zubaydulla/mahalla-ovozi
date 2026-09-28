import React, { useState, useMemo, useCallback } from 'react';
import {
  Card,
  Typography,
  Table,
  Tag,
  Button,
  Empty,
  Alert,
  Tabs,
} from 'antd';
import {
  PlusOutlined,
  CheckCircleOutlined,
  UnorderedListOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { districtClient } from '../district/district-client.js';
import { useDistrict } from '../district/district-context.js';
import { CreateDistrictDrawer } from '../components/CreateDistrictDrawer.js';
import { EditDistrictDrawer } from '../components/EditDistrictDrawer.js';
import { DistrictTopicsView } from '../components/districts/topics/DistrictTopicsView.js';
import { District } from '@mahalla-ovozi/api-contracts';
import { formatTashkentDate } from '../lib/formatters.js';

const { Title, Paragraph } = Typography;

export const DistrictsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { activeDistrictId, switchDistrict, attemptTransition } = useDistrict();

  const [editingDistrict, setEditingDistrict] = useState<District | null>(null);

  // Derive drawer open state directly from URL query param (FE2)
  const isCreateDrawerOpen = searchParams.get('action') === 'create';

  const handleOpenCreateDrawer = useCallback(() => {
    setSearchParams((prev) => {
      const nextParams = new URLSearchParams(prev);
      nextParams.set('action', 'create');
      return nextParams;
    });
  }, [setSearchParams]);

  const handleCloseCreateDrawer = useCallback(() => {
    setSearchParams((prev) => {
      const nextParams = new URLSearchParams(prev);
      nextParams.delete('action');
      return nextParams;
    });
  }, [setSearchParams]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['districts', 'list'],
    queryFn: districtClient.listDistricts,
  });

  const districts = useMemo(() => data?.districts ?? [], [data]);

  const activeTab = searchParams.get('tab') === 'topics' ? 'topics' : 'list';

  const handleTabChange = useCallback(
    (key: string) => {
      setSearchParams((prev) => {
        const nextParams = new URLSearchParams(prev);
        if (key === 'topics') {
          nextParams.set('tab', 'topics');
        } else {
          nextParams.delete('tab');
        }
        return nextParams;
      });
    },
    [setSearchParams]
  );

  const handleViewTopics = useCallback(
    (districtId: string) => {
      attemptTransition(async () => {
        if (activeDistrictId !== districtId) {
          await switchDistrict(districtId);
        }
        handleTabChange('topics');
      });
    },
    [activeDistrictId, attemptTransition, switchDistrict, handleTabChange]
  );

  const activeDistrict = districts.find((d) => d.id === activeDistrictId);

  const columns = useMemo(
    () => [
      {
        title: 'Туман номи',
        dataIndex: 'name',
        key: 'name',
        render: (name: string) => <strong>{name}</strong>,
      },
      {
        title: 'Вилоят / Ҳудуд',
        dataIndex: 'region',
        key: 'region',
        render: (region?: string) => region || '—',
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
            // P5-I: Use warning preset mapped to design system tokens
            return <Tag color="warning">Созлаш тугалланмаган</Tag>;
          }
          return <Tag color="default">{status}</Tag>;
        },
      },
      {
        title: 'Яратилган вақти',
        dataIndex: 'createdAt',
        key: 'createdAt',
        render: (createdAt: string) => formatTashkentDate(createdAt),
      },
      {
        title: 'Амаллар',
        key: 'actions',
        render: (_: unknown, record: District) => {
          const isSelected = activeDistrictId === record.id;
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {isSelected ? (
                <Tag color="success" icon={<CheckCircleOutlined />}>
                  Танланган
                </Tag>
              ) : (
                <Button
                  type="link"
                  aria-label={`Танлаш: ${record.name}`}
                  onClick={() => void switchDistrict(record.id)}
                  style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}
                >
                  Танлаш
                </Button>
              )}
              {record.status === 'ACTIVE' && (
                <Button
                  type="link"
                  aria-label={`Мавзулар: ${record.name}`}
                  onClick={() => void handleViewTopics(record.id)}
                  style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}
                >
                  Мавзулар
                </Button>
              )}
              <Button
                type="link"
                aria-label={record.status === 'SETUP_INCOMPLETE' ? `Созлаш: ${record.name}` : `Кўриш: ${record.name}`}
                onClick={() => {
                  attemptTransition(async () => {
                    if (!isSelected) {
                      await switchDistrict(record.id);
                    }
                    navigate('/');
                  });
                }}
                style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}
              >
                {record.status === 'SETUP_INCOMPLETE' ? 'Созлаш' : 'Кўриш'}
              </Button>
              <Button
                type="link"
                aria-label={`Таҳрирлаш: ${record.name}`}
                onClick={() => setEditingDistrict(record)}
                style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}
              >
                Таҳрирлаш
              </Button>
            </div>
          );
        },
      },
    ],
    [activeDistrictId, switchDistrict, attemptTransition, navigate, handleViewTopics]
  );

  const tabItems = [
    {
      key: 'list',
      label: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <UnorderedListOutlined />
          Туманлар рўйхати
        </span>
      ),
      children: (
        <Card
          variant="borderless"
          style={{ borderRadius: 12 }}
          title={
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <Title level={3} style={{ margin: 0 }}>Туманлар</Title>
                <Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
                  Тизимдаги барча туманлар рўйхати ва янги туман қўшиш
                </Paragraph>
              </div>
              {districts.length > 0 && !isError && (
                <Button
                  id="create-district-button"
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={handleOpenCreateDrawer}
                >
                  Туман қўшиш
                </Button>
              )}
            </div>
          }
        >
          {isError ? (
            <div style={{ padding: '24px 0' }}>
              <Alert
                type="error"
                showIcon
                message="Туманлар рўйхатини юклаб бўлмади"
                description="Сервер билан боғланишда хатолик юз берди. Илтимос, қайта уриниб кўринг."
                action={
                  <Button type="primary" danger onClick={() => void refetch()}>
                    Қайта уриниш
                  </Button>
                }
              />
            </div>
          ) : !isLoading && districts.length === 0 ? (
            /* AC 2: Honest Empty State for Zero Districts */
            <div style={{ padding: '48px 0', textAlign: 'center' }}>
              <Empty
                description={
                  <div>
                    <Title level={4} style={{ marginBottom: 8 }}>Ҳозирча туманлар мавжуд эмас</Title>
                    <Paragraph type="secondary">
                      Тизимда ишлаш учун биринчи туманни қўшинг.
                    </Paragraph>
                  </div>
                }
              >
                <Button
                  id="empty-create-district-button"
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={handleOpenCreateDrawer}
                >
                  Туман қўшиш
                </Button>
              </Empty>
            </div>
          ) : (
            /* P5-F: Table with role="region", aria-label, and horizontal scroll */
            <div role="region" aria-label="Туманлар рўйхати">
              <Table
                dataSource={districts}
                columns={columns}
                rowKey="id"
                loading={isLoading}
                pagination={
                  districts.length > 10
                    ? {
                        defaultPageSize: 10,
                        showSizeChanger: true,
                        pageSizeOptions: ['10', '20', '50'],
                        showTotal: (total, range) =>
                          `${total} та тумандан ${range[0]}–${range[1]} кўрсатилмоқда`,
                      }
                    : false
                }
                scroll={{ x: 'max-content' }}
              />
            </div>
          )}
        </Card>
      ),
    },
    {
      key: 'topics',
      label: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <FileTextOutlined />
          Мавзулар ва далиллар
        </span>
      ),
      children: (
        <DistrictTopicsView
          key={activeDistrictId || 'no-district'}
          activeDistrictId={activeDistrictId}
          activeDistrictName={activeDistrict?.name}
        />
      ),
    },
  ];

  return (
    <div>
      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        items={tabItems}
        size="large"
        style={{ marginBottom: 16 }}
      />

      {/* P5-D: Create District Drawer */}
      <CreateDistrictDrawer
        open={isCreateDrawerOpen}
        onClose={handleCloseCreateDrawer}
      />

      {/* Edit District Drawer */}
      <EditDistrictDrawer
        open={!!editingDistrict}
        district={editingDistrict}
        onClose={() => setEditingDistrict(null)}
      />
    </div>
  );
};
