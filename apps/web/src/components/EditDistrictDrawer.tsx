import React, { useState, useEffect, useRef } from 'react';
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
import { districtQueryKeys } from '../district/query-keys.js';
import { useDistrict } from '../district/district-context.js';
import { useDirtyState } from '../district/useDirtyState.js';
import {
  UpdateDistrictRequestSchema,
  UpdateDistrictRequest,
  District,
} from '@mahalla-ovozi/api-contracts';
import { ApiError } from '../lib/api-client.js';

interface EditDistrictDrawerProps {
  open: boolean;
  district: District | null;
  onClose: () => void;
}

export const EditDistrictDrawer: React.FC<EditDistrictDrawerProps> = ({
  open,
  district,
  onClose,
}) => {
  const { token } = theme.useToken();
  const queryClient = useQueryClient();
  const { clearDirty, attemptTransition } = useDistrict();
  const [form] = Form.useForm();

  const [formValues, setFormValues] = useState<{ name: string; region: string }>({
    name: '',
    region: '',
  });
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; region?: string; server?: string }>({});

  const nameInputRef = useRef<InputRef>(null);
  const regionInputRef = useRef<InputRef>(null);
  const errorSummaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (district && open) {
      const initial = {
        name: district.name || '',
        region: district.region || '',
      };
      form.setFieldsValue(initial);
      setFormValues(initial);
      setFieldErrors({});
    }
  }, [district, open, form]);

  // Form dirty state management
  const isDirty =
    open && district
      ? formValues.name.trim() !== (district.name || '').trim() ||
        formValues.region.trim() !== (district.region || '').trim()
      : false;
  useDirtyState('edit-district-drawer', isDirty);

  const mutation = useMutation({
    mutationFn: (data: UpdateDistrictRequest) => {
      if (!district) throw new Error('District is required');
      return districtClient.updateDistrict(district.id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['districts'] });
      if (district?.id) {
        queryClient.invalidateQueries({ queryKey: districtQueryKeys.district(district.id) });
      }
      form.resetFields();
      setFieldErrors({});
      clearDirty('edit-district-drawer');
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
          server: 'Туман маълумотларини янгилашда хатолик юз берди. Илтимос, қайта уриниб кўринг.',
        }));
      }
      setTimeout(() => errorSummaryRef.current?.focus(), 0);
    },
  });

  const handleClose = () => {
    attemptTransition(() => {
      form.resetFields();
      setFieldErrors({});
      clearDirty('edit-district-drawer');
      onClose();
    });
  };

  const handleValuesChange = (_: unknown, allValues: { name?: string; region?: string }) => {
    setFormValues((prev) => ({
      name: allValues.name !== undefined ? allValues.name : prev.name,
      region: allValues.region !== undefined ? allValues.region : prev.region,
    }));
    if (fieldErrors.name && allValues.name) {
      setFieldErrors((prev) => ({ ...prev, name: undefined }));
    }
    if (fieldErrors.region && allValues.region) {
      setFieldErrors((prev) => ({ ...prev, region: undefined }));
    }
  };

  const handleSubmit = () => {
    if (mutation.isPending || !district) return;

    const values = form.getFieldsValue() as { name?: string; region?: string };
    const rawValues = {
      name: values.name !== undefined ? values.name : formValues.name,
      region: values.region !== undefined ? values.region : formValues.region,
    };

    const parsed = UpdateDistrictRequestSchema.safeParse(rawValues);
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
      title="Туман маълумотларини таҳрирлаш"
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
            id="edit-district-submit"
            type="primary"
            onClick={handleSubmit}
            loading={mutation.isPending}
          >
            Сақлаш
          </Button>
        </div>
      }
    >
      {errorCount > 0 && (
        <div
          ref={errorSummaryRef}
          tabIndex={-1}
          id="edit-district-error-summary"
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

      <Form
        form={form}
        layout="vertical"
        initialValues={{
          name: district?.name || '',
          region: district?.region || '',
        }}
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
            id="edit-district-name-input"
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
            id="edit-district-region-input"
            placeholder="Масалан: Тошкент шаҳри (ихтиёрий)"
            maxLength={100}
            disabled={mutation.isPending}
          />
        </Form.Item>
      </Form>
    </Drawer>
  );
};
