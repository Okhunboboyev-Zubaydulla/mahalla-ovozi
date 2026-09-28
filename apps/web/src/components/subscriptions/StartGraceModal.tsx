import React, { useState, useEffect } from 'react';
import { Modal, Form, Input, Alert, Typography, Space, theme } from 'antd';
import { WarningOutlined, LockOutlined } from '@ant-design/icons';
import { containsProhibitedSecrets } from '@mahalla-ovozi/api-contracts';

const { Text, Paragraph } = Typography;

export interface StartGraceModalProps {
  open: boolean;
  districtId: string;
  districtName: string;
  isPending: boolean;
  onConfirm: (payload: { reason?: string }) => Promise<void>;
  onClose: () => void;
}

export const StartGraceModal: React.FC<StartGraceModalProps> = ({
  open,
  districtId,
  districtName,
  isPending,
  onConfirm,
  onClose,
}) => {
  const { token } = theme.useToken();
  const [form] = Form.useForm();
  const [hasSecretError, setHasSecretError] = useState(false);

  useEffect(() => {
    if (open) {
      form.resetFields();
      setHasSecretError(false);
    }
  }, [districtId, open, form]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      const reason = values.reason?.trim();
      if (reason && containsProhibitedSecrets(reason)) {
        setHasSecretError(true);
        return;
      }
      setHasSecretError(false);
      await onConfirm({ reason: reason || undefined });
      form.resetFields();
    } catch {
      // Form validation error
    }
  };

  const handleCancel = () => {
    if (!isPending) {
      form.resetFields();
      setHasSecretError(false);
      onClose();
    }
  };

  return (
    <Modal
      title={
        <Space>
          <WarningOutlined style={{ color: token.colorWarning }} />
          <span>Имтиёзли даврни бошлаш (Start Grace)</span>
        </Space>
      }
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      okText="Имтиёзли даврни бошлаш"
      cancelText="Бекор қилиш"
      okButtonProps={{
        danger: true,
        loading: isPending,
      }}
      cancelButtonProps={{
        autoFocus: true,
        disabled: isPending,
      }}
      destroyOnClose
      maskClosable={false}
      keyboard={!isPending}
      closable={!isPending}
      focusTriggerAfterClose
      width={560}
    >
      <div style={{ marginTop: 12, marginBottom: 16 }}>
        <Paragraph>
          Сиз <Text strong>{districtName}</Text> (ID: <Text code>{districtId}</Text>) тумани учун 7 кунлик имтиёзли даврни бошламоқчисиз.
        </Paragraph>

        <Alert
          type="warning"
          showIcon
          message="Имтиёзли давр (Grace) оқибатлари:"
          description={
            <ul style={{ margin: '6px 0 0 0', paddingLeft: 18 }}>
              <li>Telegram хабарларини қабул қилиш ва AI таҳлили тўхтатилмайди.</li>
              <li>Ҳокимнинг бошқарув панелига кириш ҳуқуқи сақланиб қолади.</li>
              <li>90 кунлик маълумотларни сақлаш (retention) қоидалари одатдагидек ишлайди.</li>
              <li>
                <Text strong style={{ color: token.colorWarningText }}>
                  Аниқ 7 кундан (168 соат) сўнг туман автоматик равишда тўхтатилади (Suspended)
                </Text>
                , агар унгача фаол ҳолатга тикланмаса.
              </li>
            </ul>
          }
          style={{ marginBottom: 16 }}
        />

        <Form form={form} layout="vertical">
          <Form.Item
            name="reason"
            label="Имтиёзли даврни бошлаш сабаби (ихтиёрий):"
            rules={[
              { max: 1000, message: 'Сабаб 1000 та белгидан ошмаслиги керак.' },
            ]}
          >
            <Input.TextArea
              rows={3}
              placeholder="Масалан: Обуна тўлови бўйича музокаралар кетмоқда..."
              maxLength={1000}
              showCount
              disabled={isPending}
              onChange={(e) => {
                if (hasSecretError && !containsProhibitedSecrets(e.target.value)) {
                  setHasSecretError(false);
                }
              }}
            />
          </Form.Item>

          {hasSecretError && (
            <Alert
              type="error"
              showIcon
              icon={<LockOutlined />}
              message="Махфий маълумотлар тақиқланган"
              description="Сабаб майдонида бот токенлари, API калитлари ёки паролларни киритиш мумкин эмас."
              style={{ marginBottom: 12 }}
            />
          )}
        </Form>
      </div>
    </Modal>
  );
};
