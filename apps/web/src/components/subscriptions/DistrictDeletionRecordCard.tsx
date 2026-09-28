import React from 'react';
import { Card, Typography, Descriptions, Alert, Button, Space, Tag, theme } from 'antd';
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  SyncOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { DistrictDeletionRecord } from '@mahalla-ovozi/api-contracts';
import {
  formatTashkentDate,
  formatBackupExpiryStatus,
} from '../../lib/formatters.js';

const { Title, Text, Paragraph } = Typography;

export interface DistrictDeletionRecordCardProps {
  deletionRecord: DistrictDeletionRecord;
  onVerifyBackupExpiry?: () => void;
  isVerifying?: boolean;
  onBack?: () => void;
  isOffline?: boolean;
}

export const DistrictDeletionRecordCard: React.FC<DistrictDeletionRecordCardProps> = ({
  deletionRecord,
  onVerifyBackupExpiry,
  isVerifying = false,
  onBack,
  isOffline = false,
}) => {
  const { token } = theme.useToken();

  const getBackupExpiryTag = (status: 'PENDING' | 'VERIFIED' | 'FAILED') => {
    switch (status) {
      case 'VERIFIED':
        return (
          <Tag icon={<CheckCircleOutlined />} color="success">
            {formatBackupExpiryStatus('VERIFIED')}
          </Tag>
        );
      case 'PENDING':
        return (
          <Tag icon={<ClockCircleOutlined />} color="warning">
            {formatBackupExpiryStatus('PENDING')}
          </Tag>
        );
      case 'FAILED':
        return (
          <Tag icon={<CloseCircleOutlined />} color="error">
            {formatBackupExpiryStatus('FAILED')}
          </Tag>
        );
      default:
        return <Tag>{status}</Tag>;
    }
  };

  return (
    <Card
      variant="borderless"
      style={{
        backgroundColor: token.colorBgContainer,
        borderRadius: token.borderRadiusLG,
      }}
      title={
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
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
                {deletionRecord.districtName} (Ўчирилган)
              </Title>
              <Text type="secondary" style={{ fontSize: 13 }}>
                ID: {deletionRecord.districtId} • Маълумотнома ID: {deletionRecord.id}
              </Text>
            </div>
          </Space>

          <Space wrap>
            {onVerifyBackupExpiry && (
              <Button
                type="primary"
                icon={<SyncOutlined />}
                onClick={onVerifyBackupExpiry}
                loading={isVerifying}
                disabled={isOffline || deletionRecord.backupExpiryStatus === 'VERIFIED'}
              >
                Заҳирани текшириш (Verify Backup Expiry)
              </Button>
            )}
          </Space>
        </div>
      }
    >
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {/* Milestone 1: Live System Deletion */}
        <Alert
          type="info"
          showIcon
          icon={<SafetyCertificateOutlined />}
          message="1-босқич: Жонли тизим маълумотларини тўлиқ ўчириш (Live Deletion)"
          description={
            <span>
              Туман маълумотлари (Telegram хабарлари, қабул қилинган далиллар, мавзулар, AI амаллари ва Ҳоким ҳисоби) жонли тизимдан бутунлай ўчирилган. Ҳолати:{' '}
              <Tag color="success" icon={<CheckCircleOutlined />}>
                ЯКУНЛАНГАН (COMPLETED)
              </Tag>
              . Ўчирилган вақт: <Text strong>{formatTashkentDate(deletionRecord.actualLiveDeletionAt)}</Text>.
            </span>
          }
          style={{ borderRadius: token.borderRadius }}
        />

        {/* Milestone 2: Protected Backup Expiry */}
        {deletionRecord.backupExpiryStatus === 'VERIFIED' ? (
          <Alert
            type="success"
            showIcon
            message="2-босқич: Ҳимояланган заҳира нусхалари муддати (Backup Expiry)"
            description={
              <span>
                Заҳира омбори (pgBackRest) муваффақиятли текширилди. Туманнинг жонли мавжудлик даврига оид барча заҳира нусхалари ва WAL журналлари муддати ўтиб, омбордан бутунлай тозаланганлиги тасдиқланди.{' '}
                Тасдиқланган вақт:{' '}
                <Text strong>
                  {deletionRecord.backupExpiryVerifiedAt
                    ? formatTashkentDate(deletionRecord.backupExpiryVerifiedAt)
                    : '—'}
                </Text>
                .
              </span>
            }
            style={{ borderRadius: token.borderRadius }}
          />
        ) : deletionRecord.backupExpiryStatus === 'PENDING' ? (
          <Alert
            type="warning"
            showIcon
            message="2-босқич: Ҳимояланган заҳира нусхалари кутилмоқда (Backup Expiry Pending)"
            description={
              <span>
                30 кунлик ҳимояланган заҳира сақлаш муддати давом этмоқда. Сақлаш муддати тугаш санаси:{' '}
                <Text strong style={{ color: token.colorWarningText }}>
                  {formatTashkentDate(deletionRecord.protectedBackupExpiryDeadline)}
                </Text>
                . Ушбу муддат тугагач, заҳира омборидан эски нусхалар автоматик тозаланади ва текширилади.
              </span>
            }
            style={{ borderRadius: token.borderRadius }}
          />
        ) : (
          <Alert
            type="error"
            showIcon
            message="2-босқич: Заҳира нусхалари муддатини тасдиқлашда хатолик (Backup Expiry Failed)"
            description={
              <span>
                30 кунлик муддат ўтган бўлса-да, заҳира омборида эски нусхалар мавжуд ёки омборни текширишда хатолик юз берди. Тизим ҳолати диагностикаси (System Health) бўлимида тегишли муаммо рўйхатга олинган.
              </span>
            }
            style={{ borderRadius: token.borderRadius }}
          />
        )}

        {/* Surviving Tombstone Privacy Safe Guarantee */}
        <Alert
          type="info"
          showIcon
          message="Махфийлик ва маълумотлар хавфсизлиги кафолати"
          description="Ушбу маълумотнома фақатгина оператив ўчирилганлик далили бўлиб, унда фуқароларнинг хабарлари, шахсий маълумотлари, далил иқтибослари, пароллар ёки тўлов карталари сақланмайди."
          style={{ borderRadius: token.borderRadius }}
        />

        <Descriptions
          bordered
          column={{ xs: 1, sm: 1, md: 2, lg: 2, xl: 2 }}
          size="middle"
        >
          <Descriptions.Item label="Жонли тизимдан ўчириш ҳолати">
            <Tag color="success">
              {deletionRecord.liveDeletionStatus === 'COMPLETED'
                ? 'Якунланган (Completed)'
                : deletionRecord.liveDeletionStatus}
            </Tag>
          </Descriptions.Item>

          <Descriptions.Item label="Заҳира нусхалари муддати ҳолати">
            {getBackupExpiryTag(deletionRecord.backupExpiryStatus)}
          </Descriptions.Item>

          <Descriptions.Item label="Жонли тизимдан ўчирилган вақт">
            <Text style={{ wordBreak: 'break-word' }}>
              {formatTashkentDate(deletionRecord.actualLiveDeletionAt)}
            </Text>
          </Descriptions.Item>

          <Descriptions.Item label="Заҳира муддати тугаш муддати">
            <Text style={{ wordBreak: 'break-word' }}>
              {formatTashkentDate(deletionRecord.protectedBackupExpiryDeadline)}
            </Text>
          </Descriptions.Item>

          <Descriptions.Item label="Заҳира муддати тасдиқланган вақт">
            <Text style={{ wordBreak: 'break-word' }}>
              {deletionRecord.backupExpiryVerifiedAt
                ? formatTashkentDate(deletionRecord.backupExpiryVerifiedAt)
                : '—'}
            </Text>
          </Descriptions.Item>

          <Descriptions.Item label="Бекор қилиш сабаби">
            <Paragraph style={{ margin: 0, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
              {deletionRecord.cancellationReason || '—'}
            </Paragraph>
          </Descriptions.Item>

          <Descriptions.Item label="Бекор қилинган вақт">
            <Text style={{ wordBreak: 'break-word' }}>
              {deletionRecord.cancelledAt
                ? formatTashkentDate(deletionRecord.cancelledAt)
                : '—'}
            </Text>
          </Descriptions.Item>

          <Descriptions.Item label="Бекор қилган фойдаланувчи ID">
            <Text style={{ wordBreak: 'break-word' }}>
              {deletionRecord.cancelledById || '—'}
            </Text>
          </Descriptions.Item>

          <Descriptions.Item label="Маълумотнома яратилган вақт">
            <Text style={{ wordBreak: 'break-word' }}>
              {formatTashkentDate(deletionRecord.createdAt)}
            </Text>
          </Descriptions.Item>

          <Descriptions.Item label="Сўнгги таҳрир">
            <Text style={{ wordBreak: 'break-word' }}>
              {formatTashkentDate(deletionRecord.updatedAt)}
            </Text>
          </Descriptions.Item>
        </Descriptions>
      </Space>
    </Card>
  );
};
