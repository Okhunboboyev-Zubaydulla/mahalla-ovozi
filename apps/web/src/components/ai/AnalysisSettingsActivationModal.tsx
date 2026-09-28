import React, { useState, useEffect } from 'react';
import {
  Modal,
  Form,
  Input,
  Button,
  Space,
  Alert,
  Typography,
  theme,
  Tag,
  Descriptions,
  Divider,
} from 'antd';
import {
  ExclamationCircleOutlined,
  ThunderboltOutlined,
  DisconnectOutlined,
  SafetyCertificateOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  type DistrictAnalysisSettingsDto,
  type DistrictAnalysisSettingsDraftDto,
  type SaveDistrictAnalysisSettingsDraftRequest,
  containsProhibitedSecrets,
} from '@mahalla-ovozi/api-contracts';
import { computeDistrictSettingsDiff } from './diff-utils.js';
import { ConfigurationDiffViewer } from './ConfigurationDiffViewer.js';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.js';
import { ApiError } from '../../lib/api-client.js';

const { Text, Title, Paragraph } = Typography;
const { TextArea } = Input;

export interface AnalysisSettingsActivationModalProps {
  open: boolean;
  districtId?: string;
  districtName?: string;
  activeVersionId: string;
  activeSettings: DistrictAnalysisSettingsDto;
  draftSettings:
    | DistrictAnalysisSettingsDraftDto
    | SaveDistrictAnalysisSettingsDraftRequest
    | null;
  onConfirm: (changeReason: string) => Promise<void>;
  onCancel: () => void;
  onRefresh?: () => void;
}

export const AnalysisSettingsActivationModal: React.FC<
  AnalysisSettingsActivationModalProps
> = ({
  open,
  districtId,
  districtName,
  activeVersionId,
  activeSettings,
  draftSettings,
  onConfirm,
  onCancel,
  onRefresh,
}) => {
  const { token } = theme.useToken();
  const isOffline = useOnlineStatus();
  const [form] = Form.useForm<{ changeReason: string }>();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isStaleConflict, setIsStaleConflict] = useState(false);

  // Compute diff
  const districtDiff = computeDistrictSettingsDiff(
    activeSettings,
    draftSettings,
  );

  const hasEffectiveChanges = districtDiff.hasChanges;
  const totalChangesCount = districtDiff.totalChangesCount;

  useEffect(() => {
    if (open) {
      form.resetFields();
      setErrorMessage(null);
      setIsStaleConflict(false);
    }
  }, [open, form]);

  const handleFinish = async (values: { changeReason: string }) => {
    if (isOffline || isSubmitting || !hasEffectiveChanges) return;

    const trimmedReason = (values?.changeReason || '').trim();

    if (trimmedReason.length < 5) {
      form.setFields([
        {
          name: 'changeReason',
          errors: ['Ўзгартириш сабаби камида 5 та белгидан иборат бўлиши шарт.'],
        },
      ]);
      return;
    }

    if (containsProhibitedSecrets(trimmedReason)) {
      form.setFields([
        {
          name: 'changeReason',
          errors: [
            'Ўзгартириш сабабида махфий маълумотлар (бот токенлари, API калитлар ёки пароллар) кўрсатилиши мумкин эмас.',
          ],
        },
      ]);
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setIsStaleConflict(false);

    try {
      await onConfirm(trimmedReason);
      form.resetFields();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.statusCode === 409 || err.code === 'STALE_BASELINE_VERSION') {
          setIsStaleConflict(true);
          setErrorMessage(
            err.message ||
              'Фаол созламалар версияси ўзгарган. Илтимос, саҳифани янгилаб, қайта кўриб чиқинг.',
          );
        } else {
          setErrorMessage(err.message || 'Фаоллаштиришда хатолик юз берди.');
        }
      } else if (err instanceof Error) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Кутилмаган хатолик юз берди.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const rawDate = (activeSettings as any)?.activatedAt;
  const parsedDate = rawDate ? new Date(rawDate) : null;
  const formattedActivatedAt =
    parsedDate && !isNaN(parsedDate.getTime())
      ? parsedDate.toLocaleString('uz-UZ', {
          timeZone: 'Asia/Tashkent',
        })
      : 'Дастлабки созлама';

  return (
    <Modal
      open={open}
      destroyOnHidden={true}
      title={
        <Space align="center" style={{ fontSize: 16 }}>
          <SafetyCertificateOutlined style={{ color: token.colorPrimary }} />
          <span>Таҳлил созламаларини фаоллаштириш</span>
        </Space>
      }
      onCancel={onCancel}
      width={720}
      footer={null}
      style={{ top: 24 }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Offline Banner */}
        {isOffline && (
          <Alert
            message="Тармоқ билан алоқа узилган"
            description="Сиз офлайн режимдасиз. Фаоллаштириш учун интернет алоқаси талаб этилади."
            type="warning"
            showIcon
            icon={<DisconnectOutlined />}
          />
        )}

        {/* Stale Baseline Conflict Alert */}
        {isStaleConflict && (
          <Alert
            message="Версиялар зиддияти (409 Conflict)"
            description={
              <div>
                <Paragraph style={{ margin: '0 0 8px 0' }}>
                  {errorMessage}
                </Paragraph>
                {onRefresh && (
                  <Button
                    size="small"
                    type="primary"
                    icon={<ReloadOutlined />}
                    onClick={onRefresh}
                  >
                    Саҳифани янгилаш
                  </Button>
                )}
              </div>
            }
            type="error"
            showIcon
          />
        )}

        {/* General Error Alert */}
        {!isStaleConflict && errorMessage && (
          <Alert
            message="Хатолик"
            description={errorMessage}
            type="error"
            showIcon
          />
        )}

        {/* Target Scope & Active Version Metadata */}
        <Descriptions
          bordered
          size="small"
          column={{ xs: 1, sm: 2 }}
          style={{ background: token.colorFillAlter }}
        >
          <Descriptions.Item label="Таҳлил доираси (Scope)">
            <Tag color="cyan">
              {districtName || 'Туман'} (ID: {districtId})
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Жорий фаол версия">
            <Text strong code>
              {activeVersionId}
            </Text>{' '}
            <Text type="secondary" style={{ fontSize: 12 }}>
              ({formattedActivatedAt})
            </Text>
          </Descriptions.Item>
        </Descriptions>

        {/* Future-Only Invariant Notice Banner (AC 4, AD-8) */}
        <Alert
          message="Келгуси таҳлиллар учун қўллаш қоидаси (AD-8 Future-Only Invariant)"
          description="Ушбу созламалар фақат келгуси таҳлиллар учун амал қилади. Аввал қайта ишланган хабарлар ва тарихий мавзулар қайта ҳисобланмайди ва ўзгартирилмайди."
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
        />

        {/* Field-Level Diff Presentation Section (AC 1, 2, 3) */}
        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <Title level={5} style={{ margin: 0, fontSize: 14 }}>
              Созламалар ўзгаришлари таққосламаси
            </Title>
            {hasEffectiveChanges ? (
              <Tag color="orange">
                Жами ўзгаришлар: {totalChangesCount} та
              </Tag>
            ) : (
              <Tag color="default">Ўзгаришлар мавжуд эмас</Tag>
            )}
          </div>

          <ConfigurationDiffViewer
            districtDiff={districtDiff}
          />
        </div>

        {/* No effective changes blocker warning */}
        {!hasEffectiveChanges && (
          <Alert
            message="Фаоллаштириш чекланган"
            description="Қораламада фаол созламаларга нисбатан ҳеч қандай ўзгариш мавжуд эмас. Фаоллаштириш учун аввал камида битта созлама ёки атамани таҳрирланг."
            type="info"
            showIcon
          />
        )}

        <Divider style={{ margin: '8px 0' }} />

        {/* Mandatory Operational Change Reason Form (AC 5) */}
        <Form
          form={form}
          layout="vertical"
          onFinish={handleFinish}
          requiredMark="optional"
        >
          <Form.Item
            name="changeReason"
            label={
              <Text strong>
                Фаоллаштириш сабаби (мажбурий)
              </Text>
            }
            extra="Фаоллаштириш сабабини киритинг (камида 5 та, максимум 500 та белги). Сабабда шахсий маълумотлар, Telegram бот токенлари ёки API калитларни ёзиш қатъиян ман этилади."
            rules={[
              {
                required: true,
                message: 'Ўзгартириш сабаби киритилиши шарт.',
              },
              {
                min: 5,
                message: 'Ўзгартириш сабаби камида 5 та белгидан иборат бўлиши керак.',
              },
              {
                max: 500,
                message: 'Ўзгартириш сабаби 500 та белгидан ошмаслиги керак.',
              },
              {
                validator: async (_, value) => {
                  if (value && containsProhibitedSecrets(value)) {
                    throw new Error(
                      'Ўзгартириш сабабида махфий маълумотлар (бот токенлари, API калитлар ёки пароллар) кўрсатилиши мумкин эмас.',
                    );
                  }
                },
              },
            ]}
          >
            <TextArea
              id="activation-change-reason"
              rows={3}
              maxLength={500}
              showCount
              placeholder="Масалан: Модель аниқлигини ошириш ва янги ҳудудий атамаларни киритиш"
              disabled={isOffline || !hasEffectiveChanges || isSubmitting}
            />
          </Form.Item>

          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 12,
              marginTop: 16,
            }}
          >
            <Button onClick={onCancel} disabled={isSubmitting}>
              Бекор қилиш
            </Button>

            <Button
              id="confirm-activation-button"
              type="primary"
              htmlType="submit"
              icon={<ThunderboltOutlined />}
              loading={isSubmitting}
              disabled={isOffline || !hasEffectiveChanges || isSubmitting}
              style={
                !isOffline && hasEffectiveChanges && !isSubmitting
                  ? {
                      background: token.colorWarningActive,
                      borderColor: token.colorWarningActive,
                    }
                  : undefined
              }
            >
              Фаоллаштиришни тасдиқлаш
            </Button>
          </div>
        </Form>
      </div>
    </Modal>
  );
};
