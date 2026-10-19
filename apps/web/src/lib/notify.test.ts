import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ApiError } from './api-client';
import { useNotify } from './notify';

const messageApi = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    App: Object.assign({}, actual.App, {
      useApp: () => ({ message: messageApi }),
    }),
  };
});

describe('useNotify toast surface', () => {
  afterEach(() => {
    messageApi.success.mockClear();
    messageApi.error.mockClear();
  });

  it('renders the given text on the success path', () => {
    const { result } = renderHook(() => useNotify());

    result.current.notifySuccess('Маҳалла ўчирилди');

    expect(messageApi.success).toHaveBeenCalledExactlyOnceWith('Маҳалла ўчирилди');
    expect(messageApi.error).not.toHaveBeenCalled();
  });

  it('uses the ApiError message rather than the fallback', () => {
    const { result } = renderHook(() => useNotify());
    const apiError = new ApiError('Туман топилмади.', 'NOT_FOUND', 404, false);

    result.current.notifyError(apiError, 'Хатолик юз берди');

    expect(messageApi.error).toHaveBeenCalledExactlyOnceWith('Туман топилмади.');
  });

  it('uses a plain Error message rather than the fallback', () => {
    const { result } = renderHook(() => useNotify());

    result.current.notifyError(new Error('Network down'), 'Хатолик юз берди');

    expect(messageApi.error).toHaveBeenCalledExactlyOnceWith('Network down');
  });

  it('falls back for a non-Error value', () => {
    const { result } = renderHook(() => useNotify());

    result.current.notifyError({ unexpected: true }, 'Хатолик юз берди');

    expect(messageApi.error).toHaveBeenCalledExactlyOnceWith('Хатолик юз берди');
  });
});
