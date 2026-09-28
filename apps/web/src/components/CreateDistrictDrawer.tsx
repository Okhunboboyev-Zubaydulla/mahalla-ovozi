import React, { useState, useRef } from 'react';
import {
  Drawer,
  Form,
  Input,
  Button,
  theme,
  type InputRef,
} from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { districtClient } from '../district/district-client.js';
import { useDistrict } from '../district/district-context.js';
import { useDirtyState } from '../district/useDirtyState.js';
import { CreateDistrictRequestSchema, CreateDistrictRequest } from '@mahalla-ovozi/api-contracts';
import { ApiError } from '../lib/api-client.js';

interface CreateDistrictDrawerProps {
  open: boolean;
  onClose: () => void;
}

export const CreateDistrictDrawer: React.FC<CreateDistrictDrawerProps> = ({ open, onClose }) => {
  const { token } = theme.useToken();
  const queryClient = useQueryClient();
  const { clearDirty, setActiveDistrictDirectly, attemptTransition } = useDistrict();
  const [form] = Form.useForm();

  const [formValues, setFormValues] = useState<{ name: string; region: string }>({
    name: '',
    region: '',
  });
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; region?: string; server?: string }>({});

  const nameInputRef = useRef<InputRef>(null);
  const regionInputRef = useRef<InputRef>(null);
  const errorSummaryRef = useRef<HTMLDivElement>(null);

  // Form dirty state management (FR-20)
  const isDirty =
    open && (formValues.name.trim() !== '' || formValues.region.trim() !== '');
  useDirtyState('create-district-drawer', isDirty);

  const mutation = useMutation({
    mutationFn: (data: CreateDistrictRequest) => districtClient.createDistrict(data),
    onSuccess: (data) => {
      // Invalidate districts list
      queryClient.invalidateQueries({ queryKey: ['districts'] });
      // Clear form and dirty state
      form.resetFields();
      setFormValues({ name: '', region: '' });
      setFieldErrors({});
      clearDirty('create-district-drawer');
      // Set active district to the newly created one
      setActiveDistrictDirectly(data.district.id);
      onClose();
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError) {
        setFieldErrors((prev) => ({
          ...prev,
          server: error.message,
        }));
      } else {
        setFieldErrors((prev) => ({
          ...prev,
          server: 'Туман яратишда хатолик юз берди. Илтимос, қайта уриниб кўринг.',
        }));
      }
      setTimeout(() => errorSummaryRef.current?.focus(), 0);
    },
  });

  const handleClose = () => {
    attemptTransition(() => {
      form.resetFields();
      setFormValues({ name: '', region: '' });
      setFieldErrors({});
      clearDirty('create-district-drawer');
      onClose();
    });
  };

  const handleValuesChange = (_: unknown, allValues: { name?: string; region?: string }) => {
    setFormValues({
      name: allValues.name || '',
      region: allValues.region || '',
    });
    // Clear field-specific error on change
    if (fieldErrors.name && allValues.name) {
      setFieldErrors((prev) => ({ ...prev, name: undefined }));
    }
    if (fieldErrors.region && allValues.region) {
      setFieldErrors((prev) => ({ ...prev, region: undefined }));
    }
  };

  const handleSubmit = () => {
    if (mutation.isPending) return;

    const values = form.getFieldsValue() as { name?: string; region?: string };
    const rawValues = {
      name: values.name || '',
      region: values.region || '',
    };

    // Client-side Zod validation
    const parsed = CreateDistrictRequestSchema.safeParse(rawValues);
    if (!parsed.success) {
      const errors: { name?: string; region?: string } = {};
      for (const issue of parsed.error.errors) {
        if (issue.path[0] === 'name' && !errors.name) {
          errors.name = issue.message;
        } else if (issue.path[0] === 'region' && !errors.region) {
          errors.region = issue.message;
        }
      }
      setFieldErrors(errors);
      setTimeout(() => {
        errorSummaryRef.current?.focus();
      }, 0);
      return;
    }

    setFieldErrors({});
    mutation.mutate(parsed.data);
  };

  const errorCount = Object.values(fieldErrors).filter(Boolean).length;

  return (
    <Drawer
      title="Янги туман қўшиш"
      width={480}
      open={open}
      onClose={handleClose}
      destroyOnHidden
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <Button onClick={handleClose} disabled={mutation.isPending}>
            Бекор қилиш
          </Button>
          <Button
            id="create-district-submit"
            type="primary"
            onClick={handleSubmit}
            loading={mutation.isPending}
          >
            Сақлаш
          </Button>
        </div>
      }
    >
      {/* P5-E: Accessible error summary container */}
      {errorCount > 0 && (
        <div
          ref={errorSummaryRef}
          tabIndex={-1}
          id="create-district-error-summary"
          style={{
            background: token.colorWarningBg,
            border: `1px solid ${token.colorWarningBorder}`,
            borderRadius: token.borderRadius,
            padding: 16,
            marginBottom: 24,
            outline: 'none',
          }}
        >
          <div style={{ fontWeight: 600, color: token.colorWarningText, marginBottom: 8 }}>
            Тўлдиришда хатоликлар мавжуд ({errorCount} та):
          </div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {fieldErrors.name && (
              <li>
                <button
                  type="button"
                  onClick={() => nameInputRef.current?.focus()}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: token.colorPrimary,
                    textDecoration: 'underline',
                    cursor: 'pointer',
                    fontSize: 14,
                  }}
                >
                  Туман номи: {fieldErrors.name}
                </button>
              </li>
            )}
            {fieldErrors.region && (
              <li>
                <button
                  type="button"
                  onClick={() => regionInputRef.current?.focus()}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: token.colorPrimary,
                    textDecoration: 'underline',
                    cursor: 'pointer',
                    fontSize: 14,
                  }}
                >
                  Вилоят / Ҳудуд: {fieldErrors.region}
                </button>
              </li>
            )}
            {fieldErrors.server && (
              <li style={{ color: token.colorError, fontSize: 14 }}>{fieldErrors.server}</li>
            )}
          </ul>
        </div>
      )}

      {/* Form */}
      <Form
        form={form}
        layout="vertical"
        onValuesChange={handleValuesChange}
        requiredMark="optional"
      >
        <Form.Item
          name="name"
          label="Туман номи"
          required
          validateStatus={fieldErrors.name ? 'error' : undefined}
          help={fieldErrors.name}
        >
          <Input
            ref={nameInputRef}
            id="district-name-input"
            placeholder="Масалан: Юнусобод"
            maxLength={100}
            disabled={mutation.isPending}
          />
        </Form.Item>

        <Form.Item
          name="region"
          label="Вилоят / Ҳудуд"
          validateStatus={fieldErrors.region ? 'error' : undefined}
          help={fieldErrors.region}
        >
          <Input
            ref={regionInputRef}
            id="district-region-input"
            placeholder="Масалан: Тошкент шаҳри (ихтиёрий)"
            maxLength={100}
            disabled={mutation.isPending}
          />
        </Form.Item>
      </Form>
    </Drawer>
  );
};
