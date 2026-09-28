import React, { useState, useEffect, useMemo } from 'react';
import { Modal, Form, Input, Alert, Typography, Space, theme } from 'antd';
import { ExclamationCircleOutlined, LockOutlined, WarningOutlined } from '@ant-design/icons';
import { containsProhibitedSecrets } from '@mahalla-ovozi/api-contracts';
import { formatTashkentDate } from '../../lib/formatters.js';

const { Text, Paragraph } = Typography;

export interface CancelDistrictModalProps {
  open: boolean;
  districtId: string;
  districtName: string;
  region?: string | null;
  isPending: boolean;
  onConfirm: (payload: { reason: string; confirmationDistrictName: string }) => Promise<void>;
  onClose: () => void;
}

export const CancelDistrictModal: React.FC<CancelDistrictModalProps> = ({
  open,
  districtId,
  districtName,
  region,
  isPending,
  onConfirm,
  onClose,
}) => {
  const { token } = theme.useToken();
  const [form] = Form.useForm();
  const [hasSecretError, setHasSecretError] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [reasonText, setReasonText] = useState('');

  // 30-day live deletion deadline calculation (Asia/Tashkent formatted)
  const scheduledDeletionDate = useMemo(() => {
    const d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    return formatTashkentDate(d.toISOString());
  }, [open, districtId]);

  useEffect(() => {
    if (open) {
      form.resetFields();
      setHasSecretError(false);
      setTypedName('');
      setReasonText('');
    }
  }, [districtId, open, form]);

  const isNameMatching = typedName.trim() === districtName.trim();
  const isReasonValid = reasonText.trim().length > 0 && reasonText.trim().length <= 1000 && !hasSecretError;
  const isSubmitDisabled = !isNameMatching || !isReasonValid || isPending;

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      const reason = values.reason?.trim();
      const confirmationName = values.confirmationDistrictName?.trim();

      if (!reason) {
        return;
      }

      if (containsProhibitedSecrets(reason)) {
        setHasSecretError(true);
        return;
      }
      setHasSecretError(false);

      if (confirmationName !== districtName.trim()) {
        form.setFields([
          {
            name: 'confirmationDistrictName',
            errors: ['Туман номи мос келмади.'],
          },
        ]);
        return;
      }

      await onConfirm({
        reason,
        confirmationDistrictName: confirmationName,
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
      setTypedName('');
      setReasonText('');
      onClose();
    }
  };

  return (
    <Modal
      title={
        <Space>
          <ExclamationCircleOutlined style={{ color: token.colorError }} />
          <span>Туманни бекор қилиш (Cancel District)</span>
        </Space>
      }
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      okText="Туманни бекор қилиш"
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
        {/* Explicit District Demarcation */}
        <Paragraph>
          Сиз танланган туманни тизимдан бекор қилмоқчисиз:
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
            <Text strong style={{ fontSize: 15 }}>{districtName}</Text>
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {region ? `${region} • ` : ''}ID: <Text code>{districtId}</Text>
            </Text>
          </div>
        </div>

        {/* 7-Point Consequence Warning Alert */}
        <Alert
          type="error"
          showIcon
          icon={<WarningOutlined />}
          message="Бекор қилишнинг 7 та асосий оқибатлари:"
          description={
            <ol style={{ margin: '8px 0 0 0', paddingLeft: 20 }}>
              <li>
                <Text strong>30 кунлик тиклаш муддати:</Text> Тизимдан тўлиқ ўчирилиш муддати — <Text strong style={{ color: token.colorErrorText }}>{scheduledDeletionDate}</Text>.
              </li>
              <li>
                <Text strong>Ҳимояланган захира нусхалари:</Text> Тўлиқ ўчирилгандан сўнг максимал 30 кун ичида захира нусхаларидан ҳам бутунлай чиқарилади.
              </li>
              <li>
                <Text strong>Амаллар тўхтатилиши:</Text> Telegram хабарлари қабули, AI таҳлил вазифалари ва Ҳоким кириш ҳуқуқи зудлик билан тўхтатилади.
              </li>
              <li>
                <Text strong>Бот токени ўчирилиши:</Text> Фаол Telegram бот токен маълумотлари хотирадан бутунлай ўчирилади ва қайта тикланмайди.
              </li>
              <li>
                <Text strong>90 кунлик сақлаш (Retention):</Text> 30 кунлик тиклаш даврида 90 кунлик маълумотларни тозалаш тартиби одатдагидек давом этади.
              </li>
              <li>
                <Text strong>Маълумотларни тиклаш чеклови:</Text> Қайта тикланганда фақат 90 кунлик муддати ўтмаган мавжуд маълумотлар сақланиб қолади.
              </li>
              <li>
                <Text strong>Ўтказиб юборилган хабарлар:</Text> Бекор қилинган даврдаги Telegram хабарлари қайта юкланмайди ва тикланмайди.
              </li>
            </ol>
          }
          style={{ marginBottom: 16 }}
        />

        <Form
          form={form}
          layout="vertical"
          onKeyDown={(e) => {
            // Prevent Enter key in form fields from triggering destructive submission
            if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
              e.preventDefault();
            }
          }}
        >
          {/* Reason Input */}
          <Form.Item
            name="reason"
            label="Бекор қилиш сабаби (мажбурий):"
            rules={[
              { required: true, message: 'Бекор қилиш сабабини киритинг.' },
              { max: 1000, message: 'Сабаб 1000 та белгидан ошмаслиги керак.' },
            ]}
            extra="Фақат операцион маълумот киритинг. Бот токенлари, API калитлар, пароллар ёки фуқароларнинг шахсий маълумотларини киритиш тақиқланади."
          >
            <Input.TextArea
              rows={3}
              placeholder="Масалан: Шартнома муддати тугаши муносабати билан туман фаолияти бекор қилинмоқда..."
              maxLength={1000}
              showCount
              disabled={isPending}
              onChange={(e) => {
                const val = e.target.value;
                setReasonText(val);
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
              description="Махфий маълумотлар (бот токенлари, API калитлар ёки пароллар) кўрсатилиши мумкин эмас."
              style={{ marginBottom: 16 }}
            />
          )}

          {/* Typed Name Confirmation Input */}
          <Form.Item
            name="confirmationDistrictName"
            label={
              <span>
                Тасдиқлаш учун туман номини тўлиқ киритинг (<Text code strong>{districtName}</Text>):
              </span>
            }
            rules={[
              { required: true, message: 'Туман номини тасдиқлаш учун тўлиқ киритинг.' },
            ]}
          >
            <Input
              placeholder={districtName}
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
