import React, { useState, useEffect } from 'react';
import { Modal, Form, Input, Alert, Typography, Space, theme } from 'antd';
import { ExclamationCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { ApiError } from '../../lib/api-client.js';

const { Text, Paragraph } = Typography;

interface DeleteArchivedMahallaFormValues {
  confirmMahallaName: string;
}

export interface DeleteArchivedMahallaModalProps {
  open: boolean;
  topicId: string;
  mahallaName: string;
  districtName: string;
  isPending: boolean;
  onConfirm: (confirmMahallaName: string) => Promise<void>;
  onClose: () => void;
}

export const DeleteArchivedMahallaModal: React.FC<DeleteArchivedMahallaModalProps> = ({
  open,
  topicId,
  mahallaName,
  districtName,
  isPending,
  onConfirm,
  onClose,
}) => {
  const { token } = theme.useToken();
  const [form] = Form.useForm<DeleteArchivedMahallaFormValues>();
  const [typedName, setTypedName] = useState('');

  useEffect(() => {
    if (open) {
      form.resetFields();
      setTypedName('');
    }
  }, [topicId, open, form]);

  const isNameMatching = typedName.trim() === mahallaName.trim();
  const isSubmitDisabled = !isNameMatching || isPending;

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      const confirmationName = values.confirmMahallaName?.trim();

      if (!confirmationName) {
        return;
      }

      if (confirmationName !== mahallaName.trim()) {
        form.setFields([
          {
            name: 'confirmMahallaName',
            errors: ['Маҳалла номи мос келмади.'],
          },
        ]);
        return;
      }

      await onConfirm(confirmationName);
      form.resetFields();
    } catch (err: unknown) {
      // A 400 means the typed name did not match on the server; surface it on the field
      // and keep the modal open so the owner can retype it.
      if (err instanceof ApiError && err.statusCode === 400) {
        form.setFields([
          {
            name: 'confirmMahallaName',
            errors: [err.message || 'Маҳалла номи мос келмади.'],
          },
        ]);
        return;
      }
      // 409 / 404 / other failures are reported by the caller, which also refreshes the list.
    }
  };

  const handleCancel = () => {
    if (!isPending) {
      form.resetFields();
      setTypedName('');
      onClose();
    }
  };

  return (
    <Modal
      title={
        <Space>
          <ExclamationCircleOutlined style={{ color: token.colorError }} />
          <span>Архивланган маҳаллани бутунлай ўчириш</span>
        </Space>
      }
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      okText="Бутунлай ўчириш"
      cancelText="Бекор қилиш"
      okButtonProps={{
        danger: true,
        loading: isPending,
        disabled: isSubmitDisabled,
        'aria-disabled': isSubmitDisabled,
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
      width={640}
    >
      <div style={{ marginTop: 12, marginBottom: 16 }}>
        <Paragraph>
          Сиз қуйидаги архивланган маҳаллани тизимдан бутунлай ўчирмоқчисиз:
        </Paragraph>

        <div
          style={{
            backgroundColor: token.colorFillAlter,
            padding: '10px 14px',
            borderRadius: token.borderRadius,
            marginBottom: 16,
            border: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <div>
            <Text strong style={{ fontSize: 15 }}>{mahallaName}</Text>
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {districtName ? `${districtName} • ` : ''}ID: <Text code>{topicId}</Text>
            </Text>
          </div>
        </div>

        <Alert
          type="error"
          showIcon
          icon={<WarningOutlined />}
          message="Бу амални қайтариб бўлмайди"
          description={
            <div>
              <p style={{ margin: '0 0 8px 0' }}>
                Тасдиқланганда ушбу маҳалла мавзуси <Text strong>далиллар</Text>,{' '}
                <Text strong>проекциялар</Text> ва унга боғлиқ барча ёзувлар билан бирга{' '}
                <Text strong style={{ color: token.colorErrorText }}>бутунлай ўчирилади</Text>.
              </p>
              <p style={{ margin: 0 }}>
                Учирилгандан сўнг маълумотларни тиклаб бўлмайди ва маҳалла рўйхатдан йўқолади.
              </p>
            </div>
          }
          style={{ marginBottom: 16 }}
        />

        <Form
          form={form}
          layout="vertical"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
              e.preventDefault();
            }
          }}
        >
          <Form.Item
            name="confirmMahallaName"
            label={
              <span>
                Тасдиқлаш учун маҳалла номини тўлиқ киритинг (<Text code strong>{mahallaName}</Text>):
              </span>
            }
            rules={[
              { required: true, message: 'Маҳалла номини тасдиқлаш учун тўлиқ киритинг.' },
            ]}
          >
            <Input
              placeholder={mahallaName}
              disabled={isPending}
              autoComplete="off"
              onChange={(e) => setTypedName(e.target.value)}
            />
          </Form.Item>
        </Form>
      </div>
    </Modal>
  );
};
