import React, { useMemo } from 'react';
import {
  Drawer,
  Descriptions,
  type DescriptionsProps,
  Tag,
  Typography,
  Table,
  Card,
  Space,
  Grid,
  theme,
  Empty,
  Skeleton,
  Alert,
} from 'antd';
import {
  SafetyCertificateOutlined,
  GlobalOutlined,
  UserOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import {
  AuditHistoryItem,
  AuditEvent,
  PermanentDeletionProof,
  AuditActorRole,
} from '@mahalla-ovozi/api-contracts';
import {
  formatTashkentDate,
  getActionDisplayNameUz,
} from '../../lib/formatters.js';

const { Text, Paragraph } = Typography;
const { useBreakpoint } = Grid;

interface AuditEventDetailDrawerProps {
  open: boolean;
  event: AuditHistoryItem | null;
  loading?: boolean;
  onClose: () => void;
}

interface ValueDiffRow {
  key: string;
  field: string;
  previousValue: string;
  newValue: string;
  changeType: 'modified' | 'added' | 'removed' | 'unchanged';
}

function formatValueForDisplay(val: unknown): string {
  if (val === undefined || val === null) {
    return '—';
  }
  if (typeof val === 'object') {
    return JSON.stringify(val);
  }
  return String(val);
}

export const AuditEventDetailDrawer: React.FC<AuditEventDetailDrawerProps> = ({
  open,
  event,
  loading = false,
  onClose,
}) => {
  const screens = useBreakpoint();
  const { token } = theme.useToken();

  const isDeletionProof = event?.recordType === 'PERMANENT_DELETION_PROOF';
  const deletionProof = isDeletionProof
    ? (event as PermanentDeletionProof)
    : null;
  const auditEvent = !isDeletionProof ? (event as AuditEvent | null) : null;

  const getActorRoleTag = (role: AuditActorRole | null | undefined) => {
    switch (role) {
      case 'PRODUCT_OWNER':
        return (
          <Tag color="blue" icon={<SafetyCertificateOutlined />}>
            Маҳсулот эгаси
          </Tag>
        );
      case 'DISTRICT_HOKIM':
        return (
          <Tag color="green" icon={<UserOutlined />}>
            Туман ҳокими
          </Tag>
        );
      case 'SYSTEM':
        return (
          <Tag color="purple" icon={<GlobalOutlined />}>
            Тизим
          </Tag>
        );
      default:
        return <Tag color="default">{role || 'Номаълум'}</Tag>;
    }
  };

  const getCategoryTag = (category: string) => {
    switch (category) {
      case 'AUTH_SECURITY':
        return <Tag color="orange">Хавфсизлик ва авторизация</Tag>;
      case 'DISTRICT_ADMINISTRATION':
        return <Tag color="cyan">Туман бошқаруви</Tag>;
      case 'HOKIM_MANAGEMENT':
        return <Tag color="geekblue">Ҳоким ҳисоблари</Tag>;
      case 'TELEGRAM_INTEGRATION':
        return <Tag color="blue">Телеграм интеграцияси</Tag>;
      case 'OPERATIONAL_LIFECYCLE':
        return <Tag color="purple">Операцион жараёнлар</Tag>;
      default:
        return <Tag>{category}</Tag>;
    }
  };

  const diffData = useMemo<ValueDiffRow[]>(() => {
    if (!auditEvent) return [];
    const prev = auditEvent.previousValues || {};
    const curr = auditEvent.newValues || {};

    const allKeys = Array.from(
      new Set([...Object.keys(prev), ...Object.keys(curr)]),
    );

    return allKeys.map((key) => {
      const prevVal = prev[key];
      const currVal = curr[key];

      let changeType: ValueDiffRow['changeType'] = 'unchanged';
      if (prevVal === undefined && currVal !== undefined) {
        changeType = 'added';
      } else if (prevVal !== undefined && currVal === undefined) {
        changeType = 'removed';
      } else if (JSON.stringify(prevVal) !== JSON.stringify(currVal)) {
        changeType = 'modified';
      }

      return {
        key,
        field: key,
        previousValue: formatValueForDisplay(prevVal),
        newValue: formatValueForDisplay(currVal),
        changeType,
      };
    });
  }, [auditEvent]);

  const customMetadataKeys = useMemo(() => {
    if (!auditEvent || !auditEvent.metadata) return {};
    const meta = { ...auditEvent.metadata };
    delete meta.reason;
    delete meta.previousState;
    delete meta.previousValues;
    delete meta.newState;
    delete meta.newValues;
    return meta;
  }, [auditEvent]);

  const standardDescriptionItems = useMemo<DescriptionsProps['items']>(() => {
    if (!auditEvent) return [];
    return [
      {
        key: 'createdAt',
        label: 'Сана ва вақт (Тошкент)',
        children: formatTashkentDate(auditEvent.createdAt),
      },
      {
        key: 'actor',
        label: 'Бажарувчи (Актор)',
        children: (
          <Space wrap size="small">
            {getActorRoleTag(auditEvent.actorRole)}
            {auditEvent.actorId && (
              <Text code style={{ fontSize: 12 }}>
                {auditEvent.actorId}
              </Text>
            )}
          </Space>
        ),
      },
      {
        key: 'district',
        label: 'Туман / Ҳудуд',
        children: auditEvent.districtName ? (
          <Text strong>{auditEvent.districtName}</Text>
        ) : auditEvent.districtId ? (
          <Text code>{auditEvent.districtId}</Text>
        ) : (
          <Tag color="purple">Глобал (Платформа)</Tag>
        ),
      },
      {
        key: 'action',
        label: 'Ҳаракат номи',
        children: (
          <Space direction="vertical" size={0}>
            <Text strong>{getActionDisplayNameUz(auditEvent.action)}</Text>
            <Text type="secondary" code style={{ fontSize: 11 }}>
              {auditEvent.action}
            </Text>
          </Space>
        ),
      },
      {
        key: 'category',
        label: 'Ҳаракат тоифаси',
        children: getCategoryTag(auditEvent.category),
      },
      {
        key: 'outcome',
        label: 'Натижа',
        children:
          auditEvent.outcome === 'SUCCESS' ? (
            <Tag color="success" icon={<CheckCircleOutlined />}>
              Муваффақиятли
            </Tag>
          ) : (
            <Tag color="error" icon={<CloseCircleOutlined />}>
              Хатолик
            </Tag>
          ),
      },
      {
        key: 'ipAddress',
        label: 'IP манзил',
        children: auditEvent.ipAddress ? (
          <Text code>{auditEvent.ipAddress}</Text>
        ) : (
          '—'
        ),
      },
      {
        key: 'userAgent',
        label: 'User Agent',
        children: auditEvent.userAgent ? (
          <Text
            style={{
              fontSize: 11,
              color: token.colorTextSecondary,
              wordBreak: 'break-all',
            }}
          >
            {auditEvent.userAgent}
          </Text>
        ) : (
          '—'
        ),
      },
    ];
  }, [auditEvent, token]);

  const deletionProofDescriptionItems = useMemo<
    DescriptionsProps['items']
  >(() => {
    if (!deletionProof) return [];
    return [
      {
        key: 'districtName',
        label: 'Ўчирилган туман',
        children: <Text strong>{deletionProof.districtName}</Text>,
      },
      {
        key: 'districtId',
        label: 'Туман ID',
        children: <Text code>{deletionProof.districtId}</Text>,
      },
      {
        key: 'lifecycleStatus',
        label: 'Ўчириш жараёни ҳолати',
        children: deletionProof.lifecycleComplete ? (
          <Tag color="success" icon={<CheckCircleOutlined />}>
            Тўлиқ якунланган (Lifecycle Complete)
          </Tag>
        ) : deletionProof.liveDeletionStatus === 'FAILED' ||
          deletionProof.backupExpiryStatus === 'FAILED' ||
          deletionProof.restoreReconciliationStatus === 'FAILED' ? (
          <Tag color="error" icon={<CloseCircleOutlined />}>
            Хатолик юз берган (Action Required)
          </Tag>
        ) : (
          <Tag color="processing" icon={<ClockCircleOutlined />}>
            Жараёнда (30 кунлик заҳира кутилмоқда)
          </Tag>
        ),
      },
      {
        key: 'cancelledBy',
        label: 'Бекор қилувчи',
        children: deletionProof.cancelledById ? (
          <Space size="small">
            <Tag color="blue" icon={<SafetyCertificateOutlined />}>
              Маҳсулот эгаси
            </Tag>
            <Text code style={{ fontSize: 12 }}>
              {deletionProof.cancelledById}
            </Text>
          </Space>
        ) : (
          <Tag color="purple" icon={<GlobalOutlined />}>
            Тизим (Автоматик)
          </Tag>
        ),
      },
      {
        key: 'cancelledAt',
        label: 'Бекор қилинган вақт',
        children: deletionProof.cancelledAt
          ? formatTashkentDate(deletionProof.cancelledAt)
          : '—',
      },
      {
        key: 'cancellationReason',
        label: 'Бекор қилиш сабаби / изоҳ',
        children: deletionProof.cancellationReason || '—',
      },
      {
        key: 'createdAt',
        label: 'Маълумотнома яратилган вақт',
        children: formatTashkentDate(deletionProof.createdAt),
      },
    ];
  }, [deletionProof]);

  return (
    <Drawer
      title={
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Text strong style={{ fontSize: 16 }}>
            {isDeletionProof
              ? 'Ўчирилганлик маълумотномаси тафсилоти'
              : 'Аудит ёзуви тафсилоти'}
          </Text>
          {event && (
            <Paragraph
              copyable={{ text: event.id }}
              type="secondary"
              style={{ margin: 0, fontSize: 12, fontFamily: 'monospace' }}
            >
              ID: {event.id}
            </Paragraph>
          )}
        </Space>
      }
      placement="right"
      width={screens.md ? 680 : '100%'}
      onClose={onClose}
      open={open}
      destroyOnClose={true}
      aria-label={
        isDeletionProof
          ? 'Ўчирилганлик маълумотномаси тафсилоти панели'
          : 'Аудит ёзуви тафсилоти панели'
      }
    >
      {loading ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : !event ? (
        <Empty description="Маълумот топилмади" />
      ) : isDeletionProof && deletionProof ? (
        <Space
          direction="vertical"
          size="large"
          style={{ width: '100%', display: 'flex' }}
        >
          <Descriptions
            bordered
            size="small"
            column={1}
            items={deletionProofDescriptionItems}
            styles={{ label: { width: '38%', fontWeight: 600 } }}
          />

          {/* 3-Milestone Deletion Lifecycle Verification Card */}
          <Card
            size="small"
            title={
              <Space>
                <SafetyCertificateOutlined style={{ color: token.colorPrimary }} />
                <Text strong>Ўчириш жараёни босқичлари (3-Milestone Lifecycle)</Text>
              </Space>
            }
            style={{
              borderColor: token.colorBorderSecondary,
              background: token.colorBgContainer,
            }}
          >
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              {/* Milestone 1: Live Deletion */}
              <div style={{ padding: token.paddingSM, background: token.colorFillAlter, borderRadius: token.borderRadiusSM }}>
                <Space direction="vertical" size="small" style={{ width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text strong style={{ fontSize: 13 }}>
                      1-босқич: Жонли тизимдан ўчириш (Live Deletion)
                    </Text>
                    {deletionProof.liveDeletionStatus === 'COMPLETED' ? (
                      <Tag color="success" icon={<CheckCircleOutlined />}>
                        Якунланган
                      </Tag>
                    ) : (
                      <Tag color="error" icon={<CloseCircleOutlined />}>
                        Хатолик
                      </Tag>
                    )}
                  </div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Режадаги вақт: {formatTashkentDate(deletionProof.scheduledLiveDeletionAt)} | Амалда: {formatTashkentDate(deletionProof.actualLiveDeletionAt)}
                  </Text>
                  <Text style={{ fontSize: 12 }}>
                    Барча 17 та маълумотлар базаси жадваллари ва маҳаллий хотирадан маълумотлар тўлиқ тозаланган.
                  </Text>
                </Space>
              </div>

              {/* Milestone 2: Protected Backup Expiry */}
              <div style={{ padding: token.paddingSM, background: token.colorFillAlter, borderRadius: token.borderRadiusSM }}>
                <Space direction="vertical" size="small" style={{ width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text strong style={{ fontSize: 13 }}>
                      2-босқич: Ҳимояланган заҳира нусхалари муддати (Protected Backup Expiry)
                    </Text>
                    {deletionProof.backupExpiryStatus === 'VERIFIED' ? (
                      <Tag color="success" icon={<CheckCircleOutlined />}>
                        Тасдиқланган (Verified)
                      </Tag>
                    ) : deletionProof.backupExpiryStatus === 'FAILED' ? (
                      <Tag color="error" icon={<CloseCircleOutlined />}>
                        Хатолик / Муддати ўтган
                      </Tag>
                    ) : (
                      <Tag color="processing" icon={<ClockCircleOutlined />}>
                        Кутилмоқда (30 кунлик муддат)
                      </Tag>
                    )}
                  </div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    30 кунлик заҳира тугаш муддати: {formatTashkentDate(deletionProof.protectedBackupExpiryDeadline)}
                    {deletionProof.backupExpiryVerifiedAt && ` | Текширилган: ${formatTashkentDate(deletionProof.backupExpiryVerifiedAt)}`}
                  </Text>
                  <Text style={{ fontSize: 12 }}>
                    pgBackRest заҳира омборидаги шифрланган WAL ва тўлиқ тизим нусхаларининг табиий муддати ўтиб тозаланиши.
                  </Text>
                </Space>
              </div>

              {/* Milestone 3: Disaster Restore Reconciliation */}
              <div style={{ padding: token.paddingSM, background: token.colorFillAlter, borderRadius: token.borderRadiusSM }}>
                <Space direction="vertical" size="small" style={{ width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text strong style={{ fontSize: 13 }}>
                      3-босқич: Фалокатдан сўнг тикланишни мувофиқлаштириш (Disaster Restore Reconciliation)
                    </Text>
                    {deletionProof.restoreReconciliationStatus === 'RECONCILED' ? (
                      <Tag color="success" icon={<CheckCircleOutlined />}>
                        Тасдиқланган (Reconciled)
                      </Tag>
                    ) : deletionProof.restoreReconciliationStatus === 'FAILED' ? (
                      <Tag color="error" icon={<CloseCircleOutlined />}>
                        Хатолик
                      </Tag>
                    ) : (
                      <Tag color="default">
                        {deletionProof.restoreReconciliationStatus === 'PENDING'
                          ? 'Кутилмоқда (Pending)'
                          : deletionProof.restoreReconciliationStatus || '—'}
                      </Tag>
                    )}
                  </div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Текширилган вақт: {deletionProof.restoreReconciliationVerifiedAt ? formatTashkentDate(deletionProof.restoreReconciliationVerifiedAt) : '—'}
                  </Text>
                  <Text style={{ fontSize: 12 }}>
                    Тизим фалокатдан тикланганда ўчирилганлик маълумотномаси қайта қўлланилади ва тикланган маълумотлар қайта жонланмайди.
                  </Text>
                </Space>
              </div>
            </Space>
          </Card>

          {/* Privacy Guarantee Banner */}
          <Alert
            type="info"
            showIcon
            icon={<SafetyCertificateOutlined style={{ color: token.colorInfo }} />}
            message="Шахсий маълумотлар дахлсизлиги кафолати"
            description="Ушбу маълумотнома фақат хавфсиз операцион метамаълумотларни ўз ичига олади. Фуқароларнинг Телеграм хабарлари, шахсий маълумотлари, бот токенлари ва ҳисоб маълумотлари тўлиқ тозаланган ва сақланмайди."
          />
        </Space>
      ) : auditEvent ? (
        <Space
          direction="vertical"
          size="large"
          style={{ width: '100%', display: 'flex' }}
        >
          <Descriptions
            bordered
            size="small"
            column={1}
            items={standardDescriptionItems}
            styles={{ label: { width: '35%', fontWeight: 600 } }}
          />

          {auditEvent.reason && (
            <Card
              size="small"
              title={<Text strong>Кўрсатилган сабаб / изоҳ</Text>}
              style={{
                background: token.colorFillAlter,
                borderColor: token.colorBorderSecondary,
              }}
            >
              <Paragraph style={{ margin: 0 }}>{auditEvent.reason}</Paragraph>
            </Card>
          )}

          {diffData.length > 0 && (
            <Card
              size="small"
              title={<Text strong>Ҳолат ва қийматлар ўзгариши</Text>}
              style={{ borderColor: token.colorBorderSecondary }}
            >
              <Table
                dataSource={diffData}
                pagination={false}
                size="small"
                columns={[
                  {
                    title: 'Параметр',
                    dataIndex: 'field',
                    key: 'field',
                    render: (f: string) => <Text code>{f}</Text>,
                  },
                  {
                    title: 'Олдинги қиймат',
                    dataIndex: 'previousValue',
                    key: 'previousValue',
                    render: (v: string) => (
                      <Text
                        type="secondary"
                        style={{ wordBreak: 'break-all' }}
                      >
                        {v}
                      </Text>
                    ),
                  },
                  {
                    title: 'Янги қиймат',
                    dataIndex: 'newValue',
                    key: 'newValue',
                    render: (v: string) => (
                      <Text strong style={{ wordBreak: 'break-all' }}>
                        {v}
                      </Text>
                    ),
                  },
                  {
                    title: 'Ҳолат',
                    dataIndex: 'changeType',
                    key: 'changeType',
                    width: 110,
                    render: (type: ValueDiffRow['changeType']) => {
                      switch (type) {
                        case 'added':
                          return <Tag color="green">Қўшилди</Tag>;
                        case 'removed':
                          return <Tag color="red">Ўчирилди</Tag>;
                        case 'modified':
                          return <Tag color="blue">Ўзгарди</Tag>;
                        default:
                          return <Tag color="default">Бир хил</Tag>;
                      }
                    },
                  },
                ]}
              />
            </Card>
          )}

          {Object.keys(customMetadataKeys).length > 0 && (
            <Card
              size="small"
              title={<Text strong>Қўшимча метамаълумотлар</Text>}
              style={{ borderColor: token.colorBorderSecondary }}
            >
              <pre
                style={{
                  margin: 0,
                  padding: token.paddingSM,
                  background: token.colorFillQuaternary,
                  borderRadius: token.borderRadiusSM,
                  fontSize: 12,
                  maxHeight: 250,
                  overflowY: 'auto',
                  fontFamily: 'monospace',
                }}
              >
                {JSON.stringify(customMetadataKeys, null, 2)}
              </pre>
            </Card>
          )}
        </Space>
      ) : null}
    </Drawer>
  );
};

