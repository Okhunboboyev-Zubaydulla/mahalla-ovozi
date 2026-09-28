import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  Typography,
  Progress,
  List,
  Tag,
  Button,
  Alert,
  Tooltip,
  Space,
  Spin,
  theme,
} from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { districtClient } from '../district/district-client.js';
import { districtQueryKeys } from '../district/query-keys.js';
import { useDistrictReadiness } from '../district/useDistrictReadiness.js';
import { DisclosureConfirmationModal } from './DisclosureConfirmationModal.js';
import { DistrictActivationModal } from './DistrictActivationModal.js';
import { EditDistrictDrawer } from './EditDistrictDrawer.js';
import { PrerequisiteItem } from '@mahalla-ovozi/api-contracts';
import { formatTashkentDate } from '../lib/formatters.js';

const { Title, Paragraph, Text } = Typography;

interface DistrictOnboardingChecklistProps {
  districtId: string;
}

export const DistrictOnboardingChecklist: React.FC<DistrictOnboardingChecklistProps> = ({
  districtId,
}) => {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const { readiness, isLoading, isError, refetch } = useDistrictReadiness(districtId);
  const [disclosureModalOpen, setDisclosureModalOpen] = useState(false);
  const [activationModalOpen, setActivationModalOpen] = useState(false);
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);

  const { data: districtData } = useQuery({
    queryKey: districtQueryKeys.district(districtId),
    queryFn: () => districtClient.getDistrict(districtId),
    enabled: !!districtId,
  });
  const district = districtData?.district || (readiness ? {
    id: districtId,
    name: readiness.districtName,
    region: undefined,
    status: readiness.status,
    createdAt: readiness.evaluatedAt,
  } : null);

  if (isLoading) {
    return (
      <Card variant="borderless" style={{ borderRadius: 12, textAlign: 'center', padding: 48 }}>
        <Spin size="large" />
        <Paragraph type="secondary" style={{ marginTop: 16 }}>
          Туман тайёрлик ҳолати юкланмоқда...
        </Paragraph>
      </Card>
    );
  }

  if (isError || !readiness) {
    return (
      <Card variant="borderless" style={{ borderRadius: 12 }}>
        <Alert
          type="error"
          showIcon
          message="Тайёрлик маълумотларини юклаб бўлмади"
          description="Сервер билан боғланишда хатолик юз берди. Илтимос, қайта уриниб кўринг."
          action={
            <Button type="primary" danger onClick={() => void refetch()} style={{ minHeight: 44 }}>
              Қайта уриниш
            </Button>
          }
        />
      </Card>
    );
  }

  const isAlreadyActive = readiness.status === 'ACTIVE';
  const progressPercent = Math.round((readiness.passedCount / readiness.totalCount) * 100);

  const renderStatusTag = (item: PrerequisiteItem) => {
    switch (item.status) {
      case 'passed':
        return (
          <Tag color="success" icon={<CheckCircleOutlined />}>
            Бажарилди
          </Tag>
        );
      case 'failed':
        return (
          <Tag color="error" icon={<CloseCircleOutlined />}>
            Хатолик
          </Tag>
        );
      case 'incomplete':
      default:
        return (
          <Tag color="warning" icon={<ClockCircleOutlined />}>
            Тугалланмаган
          </Tag>
        );
    }
  };

  const renderItemAction = (item: PrerequisiteItem) => {
    if (isAlreadyActive) {
      if (item.completedAt) {
        return (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {formatTashkentDate(item.completedAt)}
          </Text>
        );
      }
      return null;
    }

    if (item.key === 'disclosure_confirmation' && item.status !== 'passed') {
      return (
        <Button
          id="open-disclosure-modal-button"
          type="primary"
          onClick={() => setDisclosureModalOpen(true)}
          style={{ minHeight: 44 }}
        >
          Тасдиқлаш
        </Button>
      );
    }

    if (item.actionRequired && item.actionPath && item.status !== 'passed') {
      return (
        <Button
          id={`action-button-${item.key}`}
          type="primary"
          onClick={() => navigate(item.actionPath!)}
          style={{ minHeight: 44 }}
        >
          Созлаш
        </Button>
      );
    }

    if (item.completedAt) {
      return (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {formatTashkentDate(item.completedAt)}
        </Text>
      );
    }

    return null;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Card variant="borderless" style={{ borderRadius: 12 }}>
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <Space direction="horizontal" size="middle" align="center">
                <Title level={3} style={{ margin: 0 }}>
                  Туманни фаоллаштиришга тайёрлаш
                </Title>
                <Button
                  id="edit-district-checklist-header-button"
                  type="default"
                  icon={<EditOutlined />}
                  onClick={() => setEditDrawerOpen(true)}
                  style={{ minHeight: 32 }}
                >
                  Таҳрирлаш
                </Button>
              </Space>
              {district?.region && (
                <Text type="secondary" style={{ display: 'block', marginTop: 2, fontSize: 13 }}>
                  {district.name} ({district.region})
                </Text>
              )}
            </div>
            {isAlreadyActive && (
              <Tag color="success" icon={<CheckCircleOutlined />} style={{ fontSize: 14, padding: '4px 12px' }}>
                Фаол туман
              </Tag>
            )}
          </div>
          <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            {isAlreadyActive
              ? 'Ушбу туман муваффақиятли фаоллаштирилган ва тизимда тўлиқ ишламоқда.'
              : `Туманни тизимга тўлиқ улаш учун қуйидаги барча ${readiness.totalCount} та талаб бажарилиши шарт.`}
          </Paragraph>
        </div>

        {/* Active Banner */}
        {isAlreadyActive && (
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleOutlined />}
            message="Туман расман фаоллаштирилган"
            description="Барча созламалар ва хавфсизлик талаблари тасдиқланган. Ҳоким аккаунти ва таҳлил тизими фаол ҳолатда."
            style={{ marginBottom: 24 }}
          />
        )}

        {/* Progress summary */}
        <div
          style={{
            background: token.colorFillAlter,
            borderRadius: 8,
            padding: 16,
            marginBottom: 24,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <Text strong>Умумий тайёрлик ҳолати</Text>
            <Tag color={isAlreadyActive || readiness.isActivationReady ? 'success' : 'processing'}>
              {readiness.passedCount} / {readiness.totalCount} та талаб бажарилди
            </Tag>
          </div>
          <Progress
            percent={progressPercent}
            status={isAlreadyActive || readiness.isActivationReady ? 'success' : 'active'}
            strokeColor={token.colorPrimary}
          />
        </div>

        {/* Prerequisites list */}
        <List
          itemLayout="horizontal"
          dataSource={readiness.items}
          renderItem={(item) => (
            <List.Item
              key={item.key}
              actions={[renderItemAction(item)].filter(Boolean)}
              style={{
                padding: '16px 12px',
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <List.Item.Meta
                title={
                  <Space direction="horizontal" size="small" wrap>
                    <Text strong>{item.label}</Text>
                    {renderStatusTag(item)}
                  </Space>
                }
                description={
                  <div style={{ marginTop: 4 }}>
                    <div>{item.description}</div>
                    {item.blockerReason && item.status !== 'passed' && (
                      <Text type="secondary" style={{ color: token.colorError, fontSize: 13 }}>
                        ⚠️ {item.blockerReason}
                      </Text>
                    )}
                  </div>
                }
              />
            </List.Item>
          )}
        />

        {/* Activation CTA footer */}
        <div
          style={{
            marginTop: 32,
            paddingTop: 24,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 16,
          }}
        >
          <div>
            {isAlreadyActive ? (
              <Text strong style={{ color: token.colorSuccess }}>
                ✓ Туман аллақачон фаоллаштирилган
              </Text>
            ) : !readiness.isActivationReady ? (
              <Text type="secondary" style={{ fontSize: 13 }}>
                Фаоллаштириш учун барча талаблар бажарилиши керак ({readiness.passedCount}/
                {readiness.totalCount})
              </Text>
            ) : (
              <Text strong style={{ color: token.colorPrimary }}>
                Барча талаблар бажарилди! Туманни фаоллаштириш мумкин.
              </Text>
            )}
          </div>

          {!isAlreadyActive && (
            <Tooltip
              title={
                !readiness.isActivationReady
                  ? 'Фаоллаштириш учун барча талаблар бажарилиши керак'
                  : undefined
              }
            >
              <span>
                <Button
                  id="activate-district-button"
                  type="primary"
                  size="large"
                  disabled={!readiness.isActivationReady}
                  onClick={() => setActivationModalOpen(true)}
                  style={{ minHeight: 44, minWidth: 200 }}
                >
                  Туманни фаоллаштириш
                </Button>
              </span>
            </Tooltip>
          )}
        </div>
      </Card>

      {/* Disclosure Confirmation Modal */}
      <DisclosureConfirmationModal
        open={disclosureModalOpen}
        onClose={() => setDisclosureModalOpen(false)}
        districtId={districtId}
        districtName={readiness.districtName}
      />

      {/* District Activation Modal */}
      <DistrictActivationModal
        open={activationModalOpen}
        onClose={() => setActivationModalOpen(false)}
        districtId={districtId}
        districtName={readiness.districtName}
      />

      {/* Edit District Drawer */}
      <EditDistrictDrawer
        open={editDrawerOpen}
        district={district || null}
        onClose={() => setEditDrawerOpen(false)}
      />
    </div>
  );
};

