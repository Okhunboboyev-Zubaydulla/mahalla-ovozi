import React from 'react';
import { Card, Typography, Descriptions, Alert, Button, Space, theme } from 'antd';
import {
  EditOutlined,
  ArrowLeftOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { DistrictSubscription } from '@mahalla-ovozi/api-contracts';
import { SubscriptionStatusBadge } from './SubscriptionStatusBadge.js';
import { formatTashkentDate, formatScheduledTransitionType } from '../../lib/formatters.js';

const { Title, Text, Paragraph } = Typography;

export interface DistrictSubscriptionDetailCardProps {
  subscription: DistrictSubscription;
  onEdit: () => void;
  onStartGrace?: () => void;
  onRestoreActive?: () => void;
  onCancelDistrict?: () => void;
  onStartRecovery?: () => void;
  onBack?: () => void;
  isOffline?: boolean;
}

export const DistrictSubscriptionDetailCard: React.FC<DistrictSubscriptionDetailCardProps> = ({
  subscription,
  onEdit,
  onStartGrace,
  onRestoreActive,
  onCancelDistrict,
  onStartRecovery,
  onBack,
  isOffline = false,
}) => {
  const { token } = theme.useToken();

  return (
    <Card
      variant="borderless"
      style={{
        backgroundColor: token.colorBgContainer,
        borderRadius: token.borderRadiusLG,
      }}
      title={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <Space align="center">
            {onBack && (
              <Button
                icon={<ArrowLeftOutlined />}
                onClick={onBack}
                aria-label="Барча туманларга қайтиш"
              >
                Барча туманлар
              </Button>
            )}
            <div>
              <Title level={4} style={{ margin: 0 }}>
                {subscription.districtName}
              </Title>
              <Text type="secondary" style={{ fontSize: 13 }}>
                {subscription.region ? `${subscription.region} • ` : ''}ID: {subscription.districtId}
              </Text>
            </div>
          </Space>

          <Space wrap>
            {subscription.status === 'ACTIVE' && onStartGrace && (
              <Button
                danger
                icon={<WarningOutlined />}
                onClick={onStartGrace}
                disabled={isOffline}
              >
                Имтиёзли даврни бошлаш (Grace)
              </Button>
            )}

            {(subscription.status === 'GRACE' || subscription.status === 'SUSPENDED') && onRestoreActive && (
              <Button
                type="primary"
                icon={<CheckCircleOutlined />}
                onClick={onRestoreActive}
                disabled={isOffline}
                style={isOffline ? undefined : { backgroundColor: token.colorSuccess }}
              >
                Фаол ҳолатни тиклаш (Restore Active)
              </Button>
            )}

            {['ACTIVE', 'GRACE', 'SUSPENDED'].includes(subscription.status) && onCancelDistrict && (
              <Button
                danger
                icon={<ExclamationCircleOutlined />}
                onClick={onCancelDistrict}
                disabled={isOffline}
              >
                Туманни бекор қилиш (Cancel)
              </Button>
            )}

            {subscription.status === 'CANCELLED' && onStartRecovery && (
              <Button
                type="primary"
                icon={<SyncOutlined />}
                onClick={onStartRecovery}
                disabled={
                  isOffline ||
                  (subscription.scheduledTransitionAt
                    ? new Date(subscription.scheduledTransitionAt) <= new Date()
                    : true)
                }
              >
                Туманни тиклашни бошлаш (Start Recovery)
              </Button>
            )}

            <Button
              icon={<EditOutlined />}
              onClick={onEdit}
              disabled={isOffline}
            >
              Обуна маълумотларини таҳрирлаш
            </Button>
          </Space>
        </div>
      }
    >
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {subscription.status === 'GRACE' && (
          <Alert
            type="warning"
            showIcon
            message="Туман ҳозир 7 кунлик имтиёзли даврда (Grace)"
            description={
              <span>
                Telegram қабули ва AI таҳлили одатдагидек давом этмоқда. Автоматик тўхтатилиш вақти:{' '}
                <Text strong>
                  {subscription.scheduledTransitionAt
                    ? formatTashkentDate(subscription.scheduledTransitionAt)
                    : '—'}
                </Text>
                . Тўхтатилишнинг олдини олиш учун юқоридаги «Фаол ҳолатни тиклаш» тугмасини босинг.
              </span>
            }
            style={{ borderRadius: token.borderRadius }}
          />
        )}

        {subscription.status === 'SUSPENDED' && (
          <Alert
            type="error"
            showIcon
            message="Туман фаолияти вақтинча тўхтатилган (Suspended)"
            description="Янги Telegram хабарларини қабул қилиш, AI таҳлили ва Ҳоким ҳисобига кириш вақтинча тўхтатилган. Олдин сақланган маълумотлар сақланиб қолган (90 кунлик retention ишлайди). Хизматни қайта бошлаш учун юқоридаги «Фаол ҳолатни тиклаш» тугмасини босинг."
            style={{ borderRadius: token.borderRadius }}
          />
        )}

        {subscription.status === 'CANCELLED' && (() => {
          const isExpired = subscription.scheduledTransitionAt
            ? new Date(subscription.scheduledTransitionAt) <= new Date()
            : true;
          return (
            <Alert
              type="error"
              showIcon
              icon={<ExclamationCircleOutlined />}
              message={
                isExpired
                  ? 'Туман бекор қилинган (Тиклаш муддати тугаган)'
                  : 'Туман бекор қилинган (Cancelled)'
              }
              description={
                <span>
                  Янги Telegram қабули, AI таҳлили ва Ҳоким кириш ҳуқуқи тўхтатилган. Бот токени хавфсиз тарзда ўчирилган.
                  {isExpired ? (
                    <span> 30 кунлик тиклаш муддати тугаган. Туманни қайта тиклаш мумкин эмас. Жонли тизимдан бутунлай ўчириш навбатга қўйилган ёки амалга оширилмоқда.</span>
                  ) : (
                    <span>
                      {' '}Тизимдан тўлиқ ўчирилиш муддати:{' '}
                      <Text strong style={{ color: token.colorErrorText }}>
                        {subscription.scheduledTransitionAt
                          ? formatTashkentDate(subscription.scheduledTransitionAt)
                          : '—'}
                      </Text>
                      . 30 кунлик муддат давомида туманни қайта тиклаш мумкин.
                    </span>
                  )}
                </span>
              }
              style={{ borderRadius: token.borderRadius }}
            />
          );
        })()}

        <Alert
          type="info"
          showIcon
          message="Тўловлар бўйича муҳим эслатма"
          description="Тўловлар тизимдан ташқарида (қўлда) бошқарилади. Маҳалла Овози тўловларни қабул қилмайди ва карта маълумотларини сақламайди."
          style={{ borderRadius: token.borderRadius }}
        />

        <Descriptions
          bordered
          column={{ xs: 1, sm: 1, md: 2, lg: 2, xl: 2 }}
          size="middle"
        >
          <Descriptions.Item label="Обуна ҳолати">
            <SubscriptionStatusBadge status={subscription.status} />
          </Descriptions.Item>

          <Descriptions.Item label="Ҳолат бошланган вақт">
            <Text style={{ wordBreak: 'break-word' }}>
              {formatTashkentDate(subscription.statusStartedAt)}
            </Text>
          </Descriptions.Item>

          <Descriptions.Item label="Кейинги режали ўзгариш">
            <Text style={{ wordBreak: 'break-word' }}>
              {subscription.scheduledTransitionAt
                ? `${formatTashkentDate(subscription.scheduledTransitionAt)}${
                    subscription.scheduledTransitionType
                      ? ` (${formatScheduledTransitionType(subscription.scheduledTransitionType)})`
                      : ''
                  }`
                : subscription.scheduledTransitionType
                ? `(${formatScheduledTransitionType(subscription.scheduledTransitionType)})`
                : '—'}
            </Text>
          </Descriptions.Item>

          <Descriptions.Item label="Ташқи тўлов маълумотномаси">
            <Text style={{ wordBreak: 'break-word' }}>
              {subscription.externalPaymentReference || '—'}
            </Text>
          </Descriptions.Item>

          <Descriptions.Item label="Ички қайд" span={2}>
            <Paragraph style={{ margin: 0, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
              {subscription.internalNote || '—'}
            </Paragraph>
          </Descriptions.Item>

          <Descriptions.Item label="Яратилган вақт">
            <Text style={{ wordBreak: 'break-word' }}>
              {formatTashkentDate(subscription.createdAt)}
            </Text>
          </Descriptions.Item>

          <Descriptions.Item label="Сўнгги таҳрир">
            <Text style={{ wordBreak: 'break-word' }}>
              {formatTashkentDate(subscription.updatedAt)}
            </Text>
          </Descriptions.Item>

          <Descriptions.Item label="Сўнгги таҳрир қилган фойдаланувчи ID" span={2}>
            <Text style={{ wordBreak: 'break-word' }}>
              {subscription.updatedById || '—'}
            </Text>
          </Descriptions.Item>
        </Descriptions>
      </Space>
    </Card>
  );
};
