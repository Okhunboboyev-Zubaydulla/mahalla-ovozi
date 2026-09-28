import React, { useState, useEffect } from 'react';
import {
  Modal,
  Form,
  Input,
  Alert,
  Typography,
  Space,
  Tag,
  Button,
  theme,
  Divider,
} from 'antd';
import {
  WarningOutlined,
  RollbackOutlined,
  InfoCircleOutlined,
  DisconnectOutlined,
} from '@ant-design/icons';
import {
  type DistrictAnalysisSettingsDto,
  containsProhibitedSecrets,
} from '@mahalla-ovozi/api-contracts';
import { useOnlineStatus } from '../../hooks/useOnlineStatus.js';
import { computeDistrictSettingsDiff } from './diff-utils.js';
import { ConfigurationDiffViewer } from './ConfigurationDiffViewer.js';

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

export interface AnalysisSettingsRollbackModalProps {
  open: boolean;
  districtId: string;
  districtName: string;
  activeVersion: DistrictAnalysisSettingsDto;
  targetVersion: DistrictAnalysisSettingsDto;
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
}

export const AnalysisSettingsRollbackModal: React.FC<
  AnalysisSettingsRollbackModalProps
> = (props) => {
  const {
    open,
    districtId,
    districtName,
    activeVersion,
    targetVersion,
    onConfirm,
    onCancel,
  } = props;
  const { token } = theme.useToken();
  const [form] = Form.useForm<{ changeReason: string }>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const isOffline = useOnlineStatus();

  useEffect(() => {
    if (open) {
      form.resetFields();
      setApiError(null);
    }
  }, [open, form]);

  const handleClose = () => {
    onCancel();
    // Return keyboard focus to the trigger button
    setTimeout(() => {
      const triggerBtn = document.getElementById(`btn-rollback-${targetVersion.id}`);
      if (triggerBtn) {
        triggerBtn.focus();
      }
    }, 50);
  };

  const handleFinish = async (values: { changeReason: string }) => {
    setApiError(null);
    setIsSubmitting(true);
    try {
      await onConfirm((values?.changeReason || '').trim());
      handleClose();
    } catch (err: any) {
      const msg =
        err?.message ||
        'Созламаларни қайтаришда хатолик юз берди. Илтимос, қайта уриниб кўринг.';
      setApiError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const districtDiff = computeDistrictSettingsDiff(
    props.activeVersion,
    props.targetVersion,
  );

  return (
    <Modal
      open={open}
      title={
        <Space align="center">
          <RollbackOutlined style={{ color: token.colorWarning }} />
          <span>Созламаларни олдинги версияга қайтариш (Rollback)</span>
        </Space>
      }
      onCancel={handleClose}
      destroyOnHidden={true}
      focusTriggerAfterClose={true}
      width={760}
      footer={null}
      style={{ top: 24 }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 12 }}>
        {/* Scope & Version Header */}
        <div
          style={{
            background: token.colorFillQuaternary,
            padding: '12px 16px',
            borderRadius: token.borderRadius,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              Қамров (Scope):
            </Text>
            <Text strong>
              Туман: {districtName || districtId}
            </Text>
          </div>
          <Space size="middle">
            <div>
              <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                Жорий фаол:
              </Text>
              <Tag color="success" style={{ fontWeight: 600 }}>
                V{activeVersion.version} ({activeVersion.id})
              </Tag>
            </div>
            <Text type="secondary" style={{ fontSize: 18 }}>
              ➔
            </Text>
            <div>
              <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                Қайтариладиган:
              </Text>
              <Tag color="blue" style={{ fontWeight: 600 }}>
                V{targetVersion.version} ({targetVersion.id})
              </Tag>
            </div>
          </Space>
        </div>

        {/* Future-Only Invariant Disclosure Alert */}
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message={
            <Text strong style={{ color: token.colorWarningText }}>
              Келажак учун янги версия яратиш қоидаси (Future-Only Invariant)
            </Text>
          }
          description={
            <div style={{ fontSize: 13, marginTop: 4 }}>
              <Paragraph style={{ margin: 0, color: 'inherit' }}>
                Диққат: Созламаларни қайтариш танланган тарихий версия асосида{' '}
                <Text strong>ЯНГИ келажак версиясини</Text> яратади ва фаоллаштиради.
                Аввал қайта ишланган хабарлар ва тарихий мавзулар қайта ҳисобланмайди ва
                ўзгартирилмайди.
              </Paragraph>
            </div>
          }
        />

        {/* Offline Warning */}
        {isOffline && (
          <Alert
            type="error"
            showIcon
            icon={<DisconnectOutlined />}
            message="Интернет алоқаси йўқ"
            description="Офлайн режимда созламаларни қайтариш имконсиз. Алоқа тиклангач қайта уриниб кўринг."
          />
        )}

        {/* API Error Alert */}
        {apiError && (
          <Alert
            type="error"
            showIcon
            message="Қайтариш амалиёти бажарилмади"
            description={apiError}
            closable
            onClose={() => setApiError(null)}
          />
        )}

        {/* Diff Viewer Section */}
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            Ўзгаришлар фарқи (Жорий фаол ➔ Қайтариладиган V{targetVersion.version}):
          </Text>
          <ConfigurationDiffViewer
            districtDiff={districtDiff}
            mode="rollback"
          />
        </div>

        <Divider style={{ margin: '8px 0' }} />

        {/* Operational Change Reason Form */}
        <Form
          form={form}
          layout="vertical"
          onFinish={handleFinish}
          requiredMark={true}
        >
          <Form.Item
            name="changeReason"
            label={
              <Space>
                <Text strong>Қайтариш сабаби (мажбурий)</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  (Аудит журнали учун)
                </Text>
              </Space>
            }
            extra={
              <Text type="secondary" style={{ fontSize: 12 }}>
                <InfoCircleOutlined style={{ marginRight: 4 }} />
                Қайтариш сабабини киритинг (камида 5 та белги). Махфий маълумотлар
                (Telegram бот токенлари, API калитлар) киритиш тақиқланади.
              </Text>
            }
            rules={[
              {
                required: true,
                whitespace: true,
                message: 'Қайтариш сабабини киритиш шарт.',
              },
              {
                min: 5,
                message: 'Қайтариш сабаби камида 5 та белгидан иборат бўлиши шарт.',
              },
              {
                max: 500,
                message: 'Қайтариш сабаби 500 та белгидан ошмаслиги керак.',
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
              rows={3}
              maxLength={500}
              showCount
              placeholder="Масалан: V2 даги тасдиқланган туман атамалари ва луғатига қайтиш"
              disabled={isSubmitting || isOffline}
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
            <Button
              onClick={handleClose}
              disabled={isSubmitting}
            >
              Бекор қилиш
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              loading={isSubmitting}
              disabled={isOffline}
              icon={<RollbackOutlined />}
              style={{
                background: token.colorWarning,
                borderColor: token.colorWarning,
              }}
            >
              Янги версия сифатида қайтариш
            </Button>
          </div>
        </Form>
      </div>
    </Modal>
  );
};
