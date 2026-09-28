import React, { useState, useEffect } from 'react';
import {
  Drawer,
  Form,
  Input,
  Button,
  Alert,
  Typography,
  Space,
  App as AntdApp,
} from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DistrictSubscription,
  containsProhibitedSecrets,
} from '@mahalla-ovozi/api-contracts';
import { subscriptionClient } from '../../api/subscription-client.js';
import { useDirtyState } from '../../district/useDirtyState.js';
import { ApiError } from '../../lib/api-client.js';

const { Text, Paragraph } = Typography;

export interface EditSubscriptionDrawerProps {
  open: boolean;
  subscription: DistrictSubscription | null;
  onClose: () => void;
  onSuccess?: (updated: DistrictSubscription) => void;
  isOffline?: boolean;
}

export const EditSubscriptionDrawer: React.FC<EditSubscriptionDrawerProps> = ({
  open,
  subscription,
  onClose,
  onSuccess,
  isOffline = false,
}) => {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm();

  const [formValues, setFormValues] = useState<{
    externalPaymentReference: string;
    internalNote: string;
  }>({
    externalPaymentReference: '',
    internalNote: '',
  });

  const [fieldErrors, setFieldErrors] = useState<{
    externalPaymentReference?: string;
    internalNote?: string;
    server?: string;
  }>({});

  useEffect(() => {
    if (subscription && open) {
      const initial = {
        externalPaymentReference: subscription.externalPaymentReference || '',
        internalNote: subscription.internalNote || '',
      };
      form.setFieldsValue(initial);
      setFormValues(initial);
      setFieldErrors({});
    }
  }, [subscription, open, form]);

  const initialRef = subscription?.externalPaymentReference || '';
  const initialNote = subscription?.internalNote || '';

  const isDirty =
    open &&
    (formValues.externalPaymentReference !== initialRef ||
      formValues.internalNote !== initialNote);

  useDirtyState('edit-subscription-drawer', isDirty);

  const mutation = useMutation({
    mutationFn: async (values: {
      externalPaymentReference: string;
      internalNote: string;
    }) => {
      if (!subscription) throw new Error('Туман танланмаган');

      return subscriptionClient.updateDistrictSubscription(
        subscription.districtId,
        {
          externalPaymentReference: values.externalPaymentReference.trim(),
          internalNote: values.internalNote.trim(),
        },
      );
    },
    onSuccess: (data) => {
      message.success('Обуна маълумотлари муваффақиятли сақланди.');
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      queryClient.invalidateQueries({
        queryKey: ['district-subscription', subscription?.districtId],
      });
      onSuccess?.(data.subscription);
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        setFieldErrors((prev) => ({
          ...prev,
          server: err.message,
        }));
      } else {
        setFieldErrors((prev) => ({
          ...prev,
          server: 'Сақлашда хатолик юз берди. Қайта уриниб кўринг.',
        }));
      }
    },
  });

  const handleValuesChange = (
    _: unknown,
    allValues: { externalPaymentReference?: string; internalNote?: string },
  ) => {
    const currentRef = allValues.externalPaymentReference || '';
    const currentNote = allValues.internalNote || '';

    setFormValues({
      externalPaymentReference: currentRef,
      internalNote: currentNote,
    });

    setFieldErrors((prev) => {
      const next: typeof fieldErrors = { ...prev };
      if (currentRef && containsProhibitedSecrets(currentRef)) {
        next.externalPaymentReference =
          'Махфий маълумотлар (бот токенлари, API калитлар ёки пароллар) кўрсатилиши мумкин эмас.';
      } else {
        delete next.externalPaymentReference;
      }

      if (currentNote && containsProhibitedSecrets(currentNote)) {
        next.internalNote =
          'Махфий маълумотлар (бот токенлари, API калитлар ёки пароллар) кўрсатилиши мумкин эмас.';
      } else {
        delete next.internalNote;
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const currentRef = values.externalPaymentReference?.trim() || '';
      const currentNote = values.internalNote?.trim() || '';

      const errors: typeof fieldErrors = {};

      if (currentRef && containsProhibitedSecrets(currentRef)) {
        errors.externalPaymentReference =
          'Махфий маълумотлар (бот токенлари, API калитлар ёки пароллар) кўрсатилиши мумкин эмас.';
      }

      if (currentNote && containsProhibitedSecrets(currentNote)) {
        errors.internalNote =
          'Махфий маълумотлар (бот токенлари, API калитлар ёки пароллар) кўрсатилиши мумкин эмас.';
      }

      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        return;
      }

      setFieldErrors({});
      mutation.mutate({
        externalPaymentReference: currentRef,
        internalNote: currentNote,
      });
    } catch {
      // Form validation failed
    }
  };

  return (
    <Drawer
      title={
        <div>
          <Text strong style={{ fontSize: 16 }}>
            Обуна маълумотларини таҳрирлаш
          </Text>
          {subscription && (
            <div>
              <Text type="secondary" style={{ fontSize: 13 }}>
                {subscription.districtName} (ID: {subscription.districtId})
              </Text>
            </div>
          )}
        </div>
      }
      placement="right"
      width={480}
      open={open}
      onClose={onClose}
      destroyOnClose
      extra={
        <Space>
          <Button onClick={onClose}>Бекор қилиш</Button>
          <Button
            type="primary"
            onClick={handleSubmit}
            loading={mutation.isPending}
            disabled={isOffline || !isDirty}
          >
            Сақлаш
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="Тўловлар тизими ҳақида"
          description="Тўловлар тизимдан ташқарида (қўлда) бошқарилади. Маҳалла Овози тўловларни қабул қилмайди ва карта маълумотларини сақламайди."
        />

        <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 12 }}>
          Тўлов маълумотномаси ва ички қайдлар фақат операцион маълумотлар учун мўлжалланган. Шахсий маълумотлар, Telegram бот токенлари ёки API калитларини ёзиш қатъиян ман этилади.
        </Paragraph>

        {fieldErrors.server && (
          <Alert
            type="error"
            showIcon
            message="Хатолик"
            description={fieldErrors.server}
            style={{ marginBottom: 16 }}
          />
        )}

        <Form
          form={form}
          layout="vertical"
          onValuesChange={handleValuesChange}
          disabled={mutation.isPending || isOffline}
        >
          <Form.Item
            name="externalPaymentReference"
            label="Ташқи тўлов маълумотномаси"
            validateStatus={fieldErrors.externalPaymentReference ? 'error' : undefined}
            help={fieldErrors.externalPaymentReference || undefined}
            extra="Масалан, банк шартнома рақами ёки тўлов ҳисоб-китоб индекси (макс 255 та белги)"
            rules={[
              {
                max: 255,
                message: 'Тўлов маълумотномаси 255 та белгидан ошмаслиги керак.',
              },
            ]}
          >
            <Input
              placeholder="Масалан: ШАРТНОМА-2026/08"
              maxLength={255}
              showCount
              allowClear
            />
          </Form.Item>

          <Form.Item
            name="internalNote"
            label="Ички маъмурий қайд"
            validateStatus={fieldErrors.internalNote ? 'error' : undefined}
            help={fieldErrors.internalNote || undefined}
            extra="Маъмурий ходимлар учун ички эслатмалар ва операцион изоҳлар (макс 2000 та белги)"
            rules={[
              {
                max: 2000,
                message: 'Ички қайд 2000 та белгидан ошмаслиги керак.',
              },
            ]}
          >
            <Input.TextArea
              rows={5}
              placeholder="Ички қайдлар, келишув шартлари ва операцион изоҳлар..."
              maxLength={2000}
              showCount
              allowClear
            />
          </Form.Item>
        </Form>
      </Space>
    </Drawer>
  );
};
