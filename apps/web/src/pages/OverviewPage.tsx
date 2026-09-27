import React, { useState, useMemo } from 'react';
import {
  Card,
  Typography,
  Button,
  Segmented,
  Tag,
  Alert,
  Space,
  theme,
} from 'antd';
import {
  CheckCircleOutlined,
  ApartmentOutlined,
  UnorderedListOutlined,
  CheckSquareOutlined,
  CloseOutlined,
  ReloadOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { District } from '@mahalla-ovozi/api-contracts';
import { districtClient } from '../district/district-client.js';
import { useDistrict } from '../district/district-context.js';
import { DistrictOnboardingChecklist } from '../components/DistrictOnboardingChecklist.js';
import { OverviewMetricCards } from '../components/OverviewMetricCards.js';
import { OverviewDistrictTable } from '../components/OverviewDistrictTable.js';
import { CreateDistrictDrawer } from '../components/CreateDistrictDrawer.js';
import { EditDistrictDrawer } from '../components/EditDistrictDrawer.js';

const { Title, Text, Paragraph } = Typography;

export const OverviewPage: React.FC = () => {
  const { token } = theme.useToken();
  const { activeDistrictId, switchDistrict, attemptTransition } = useDistrict();
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [editingDistrict, setEditingDistrict] = useState<District | null>(null);
  const [activeViewMode, setActiveViewMode] = useState<'checklist' | 'portfolio'>('checklist');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['districts', 'list'],
    queryFn: districtClient.listDistricts,
  });

  const districts = useMemo(() => data?.districts || [], [data]);

  const activeDistrict = useMemo(
    () => districts.find((d) => d.id === activeDistrictId),
    [districts, activeDistrictId]
  );

  const handleClearActiveDistrict = () => {
    attemptTransition(async () => {
      // Clear active district to return to global overview
      await switchDistrict('');
    });
  };

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      {/* Top Page Header */}
      <div style={{ marginBottom: 20 }}>
        <Title level={3} style={{ margin: 0, fontSize: 22 }}>
          Умумий кўриниш
        </Title>
        <Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 14 }}>
          Маҳалла Овози тизимининг барча туманлари ҳолати, кўрсаткичлари ва созлаш жараёнлари
        </Paragraph>
      </div>

      {/* Local Error Banner if districts query fails */}
      {isError && (
        <Alert
          type="error"
          showIcon
          message="Туманлар маълумотларини юклаб бўлмади"
          description="Сервер билан боғланишда хатолик юз берди ёки маълумотлар вақтинча мавжуд эмас."
          action={
            <Button
              type="primary"
              size="middle"
              icon={<ReloadOutlined />}
              onClick={() => void refetch()}
              style={{ minHeight: 40 }}
            >
              Қайта уриниш
            </Button>
          }
          style={{ marginBottom: 24, borderRadius: 10 }}
        />
      )}

      {/* 1. Operational Metrics KPI Strip */}
      <OverviewMetricCards districts={districts} loading={isLoading} />

      {/* 2. Active District Focus Context Banner (when a district is selected) */}
      {activeDistrict && (
        <Card
          variant="borderless"
          style={{
            marginBottom: 24,
            borderRadius: 12,
            background: token.colorBgContainer,
            border: `1px solid ${token.colorPrimary}`,
          }}
          bodyStyle={{ padding: '16px 20px' }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 16,
            }}
          >
            <Space direction="horizontal" size="middle" align="center">
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 8,
                  background: '#E0F2FE',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                aria-hidden="true"
              >
                <ApartmentOutlined style={{ fontSize: 20, color: token.colorPrimary }} />
              </div>

              <div>
                <Space direction="horizontal" size="small" align="center">
                  <Text strong style={{ fontSize: 16 }}>
                    {activeDistrict.name}
                  </Text>
                  {activeDistrict.status === 'ACTIVE' ? (
                    <Tag color="success" icon={<CheckCircleOutlined />}>
                      Фаол
                    </Tag>
                  ) : (
                    <Tag color="warning">Созлаш тугалланмаган</Tag>
                  )}
                </Space>
                {activeDistrict.region && (
                  <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                    {activeDistrict.region}
                  </Text>
                )}
              </div>
            </Space>

            <Space direction="horizontal" size="middle" wrap align="center">
              <Segmented<'checklist' | 'portfolio'>
                aria-label="Кўриниш режими"
                value={activeViewMode}
                onChange={(val) => setActiveViewMode(val)}
                options={[
                  {
                    label: 'Созлаш босқичлари',
                    value: 'checklist',
                    icon: <CheckSquareOutlined />,
                  },
                  {
                    label: 'Барча туманлар жадвали',
                    value: 'portfolio',
                    icon: <UnorderedListOutlined />,
                  },
                ]}
                style={{ minHeight: 38 }}
              />

              <Button
                id="active-district-edit-button"
                type="default"
                icon={<EditOutlined />}
                onClick={() => setEditingDistrict(activeDistrict)}
                style={{ minHeight: 38 }}
              >
                Таҳрирлаш
              </Button>

              <Button
                type="text"
                icon={<CloseOutlined />}
                onClick={handleClearActiveDistrict}
                style={{ color: token.colorTextSecondary, minHeight: 38 }}
              >
                Танловни ёпиш
              </Button>
            </Space>
          </div>
        </Card>
      )}

      {/* 3. Dynamic Main Content Area */}
      {activeDistrict && activeViewMode === 'checklist' ? (
        <DistrictOnboardingChecklist districtId={activeDistrict.id} />
      ) : (
        <OverviewDistrictTable
          districts={districts}
          loading={isLoading}
          onOpenCreateDrawer={() => setCreateDrawerOpen(true)}
          onSelectDistrictForFocus={() => setActiveViewMode('checklist')}
          onEditDistrict={(district) => setEditingDistrict(district)}
        />
      )}

      {/* 4. Global Create District Drawer */}
      <CreateDistrictDrawer
        open={createDrawerOpen}
        onClose={() => setCreateDrawerOpen(false)}
      />

      {/* 5. Global Edit District Drawer */}
      <EditDistrictDrawer
        open={!!editingDistrict}
        district={editingDistrict}
        onClose={() => setEditingDistrict(null)}
      />
    </div>
  );
};
