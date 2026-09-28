import React, { useState, useEffect } from 'react';
import { Modal, Form, Input, Alert, Typography, Space, theme } from 'antd';
import { CheckCircleOutlined, LockOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { SubscriptionStatus, containsProhibitedSecrets } from '@mahalla-ovozi/api-contracts';

const { Text, Paragraph } = Typography;

export interface RestoreActiveModalProps {
  open: boolean;
  districtId: string;
  districtName: string;
  currentStatus?: SubscriptionStatus;
  isPending: boolean;
  onConfirm: (payload: { reason?: string }) => Promise<void>;
  onClose: () => void;
}

export const RestoreActiveModal: React.FC<RestoreActiveModalProps> = ({
  open,
  districtId,
  districtName,
  currentStatus,
  isPending,
  onConfirm,
  onClose,
}) => {
  const { token } = theme.useToken();
  const [form] = Form.useForm();
  const [hasSecretError, setHasSecretError] = useState(false);

  const isFromSuspended = currentStatus === 'SUSPENDED';

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
          <CheckCircleOutlined style={{ color: token.colorSuccess }} />
          <span>Фаол ҳолатни тиклаш (Restore Active)</span>
        </Space>
      }
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      okText="Фаол ҳолатни тиклаш"
      cancelText="Бекор қилиш"
      okButtonProps={{
        type: 'primary',
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
          Сиз <Text strong>{districtName}</Text> (ID: <Text code>{districtId}</Text>) тумани учун фаол ҳолатни тикламоқчисиз.
        </Paragraph>

        <Alert
          type="info"
          showIcon
          icon={<InfoCircleOutlined />}
          message="Тиклаш шартлари ва оқибатлари:"
          description={
            <ul style={{ margin: '6px 0 0 0', paddingLeft: 18 }}>
              <li>Туман обунаси ва хизмат кўрсатиш тўлиқ фаол ҳолатга (ACTIVE) ўтади.</li>
              <li>
                Telegram хабарларини қабул қилиш ва AI таҳлили{' '}
                <Text strong>фақат ҳозирдан бошлаб келадиган янги хабарлар учун</Text> тикланади.
                Тўхтатилган даврдаги хабарлар қайта ишланмайди (ўтказиб юборилган хабарлар қайта тикланмайди).
              </li>
              {isFromSuspended && (
                <li>
                  <Text strong style={{ color: token.colorWarningText }}>
                    Тўхтатилган (Suspended) ҳолатдан тиклашда тизим туманнинг барча 8 та фаоллаштириш талабларини авто-текширади.
                  </Text>
                </li>
              )}
            </ul>
          }
          style={{ marginBottom: 16 }}
        />

        <Form form={form} layout="vertical">
          <Form.Item
            name="reason"
            label="Фаол ҳолатни тиклаш сабаби (ихтиёрий):"
            rules={[
              { max: 1000, message: 'Сабаб 1000 та белгидан ошмаслиги керак.' },
            ]}
          >
            <Input.TextArea
              rows={3}
              placeholder="Масалан: Обуна тўлови муваффақиятли қабул қилинди..."
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
