import React, { useState, useEffect } from 'react';
import { Modal, Form, Input, Alert, Typography, Space, theme } from 'antd';
import { SyncOutlined, LockOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { containsProhibitedSecrets } from '@mahalla-ovozi/api-contracts';

const { Text, Paragraph } = Typography;

export interface StartRecoveryModalProps {
  open: boolean;
  districtId: string;
  districtName: string;
  isPending: boolean;
  onConfirm: (payload: { reason?: string }) => Promise<void>;
  onClose: () => void;
}

export const StartRecoveryModal: React.FC<StartRecoveryModalProps> = ({
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

      await onConfirm({
        reason: reason || undefined,
      });
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
          <SyncOutlined style={{ color: token.colorPrimary }} />
          <span>Туманни тиклашни бошлаш (Start Recovery)</span>
        </Space>
      }
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      okText="Тиклашни бошлаш"
      cancelText="Бекор қилиш"
      okButtonProps={{
        type: 'primary',
        loading: isPending,
        disabled: hasSecretError || isPending,
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
      width={580}
    >
      <div style={{ marginTop: 12, marginBottom: 16 }}>
        <Paragraph>
          Сиз <Text strong>{districtName}</Text> (ID: <Text code>{districtId}</Text>) туманини қайта тиклаш жараёнини бошламоқчисиз.
        </Paragraph>

        <Alert
          type="info"
          showIcon
          icon={<InfoCircleOutlined />}
          message="Тиклаш жараёни шартлари:"
          description={
            <ul style={{ margin: '6px 0 0 0', paddingLeft: 18 }}>
              <li>
                Туман ҳолати <Text strong>Созлаш тугалланмаган (Setup Incomplete)</Text> ҳолатига ўтказилади.
              </li>
              <li>
                Режалаштирилган 30 кунлик тизимдан тўлиқ ўчириш жадвали бекор қилинади.
              </li>
              <li>
                Олдинги бот токени ўчирилганлиги сабабли, <Text strong>янги Telegram бот токени</Text> уланиши ва текширилиши керак.
              </li>
              <li>
                Туманни фаоллаштириш (Active) учун барча 8 та дастлабки талаблар тўлиқ бажарилиши шарт.
              </li>
              <li>
                Бекор қилинган вақтда ўтказиб юборилган Telegram хабарлари қайта юкланмайди.
              </li>
            </ul>
          }
          style={{ marginBottom: 16 }}
        />

        <Form form={form} layout="vertical">
          <Form.Item
            name="reason"
            label="Тиклаш сабаби (ихтиёрий):"
            rules={[
              { max: 1000, message: 'Сабаб 1000 та белгидан ошмаслиги керак.' },
            ]}
          >
            <Input.TextArea
              rows={3}
              placeholder="Масалан: Янги шартнома тузилди ва қайта уланмоқда..."
              maxLength={1000}
              showCount
              disabled={isPending}
              onChange={(e) => {
                const val = e.target.value;
                if (containsProhibitedSecrets(val)) {
                  setHasSecretError(true);
                } else {
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
              description="Сабаб майдонида бот токенлари, API калитлар ёки паролларни киритиш мумкин эмас."
              style={{ marginBottom: 12 }}
            />
          )}
        </Form>
      </div>
    </Modal>
  );
};
