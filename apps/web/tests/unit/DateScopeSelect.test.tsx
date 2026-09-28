import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateScopeSelect } from '../../src/components/topics/DateScopeSelect.js';

describe('DateScopeSelect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T12:00:00+05:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  it('renders Бугун / Кеча / Сана бўйича tabs', () => {
    render(
      <DateScopeSelect
        dateScope="today"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Бугун')).toBeTruthy();
    expect(screen.getByText('Кеча')).toBeTruthy();
    expect(screen.getByText('Сана бўйича')).toBeTruthy();
  });

  it('opens overlay immediately when custom tab is selected from a non-custom scope', () => {
    const handleChange = vi.fn();
    render(
      <DateScopeSelect
        dateScope="today"
        onChange={handleChange}
      />,
    );

    // Clicking the Segmented option for 'custom' triggers handleScopeChange
    // It should call onChange AND immediately open the overlay
    fireEvent.click(screen.getByText('Сана бўйича'));
    expect(handleChange).toHaveBeenCalledWith(
      expect.objectContaining({ dateScope: 'custom' }),
    );
    expect(screen.getByRole('dialog', { name: 'Сана оралиғини танлаш' })).toBeTruthy();
    const applyBtn = screen.getByLabelText('Киритилган саналарни қўллаш') as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);
  });

  it('toggles overlay when custom tab is clicked while already in custom scope', () => {
    render(
      <DateScopeSelect
        dateScope="custom"
        dateFrom="2026-08-27"
        dateTo="2026-09-03"
        onChange={vi.fn()}
      />,
    );

    // Click to open
    fireEvent.click(screen.getByText(/27\.08/));
    expect(screen.getByRole('dialog', { name: 'Сана оралиғини танлаш' })).toBeTruthy();

    // Click again to close
    fireEvent.click(screen.getByText(/27\.08/));
    expect(screen.queryByRole('dialog', { name: 'Сана оралиғини танлаш' })).toBeNull();
  });

  it('closes overlay when user switches to Бугун tab', () => {
    const handleChange = vi.fn();
    render(
      <DateScopeSelect
        dateScope="custom"
        dateFrom="2026-08-27"
        dateTo="2026-09-03"
        onChange={handleChange}
      />,
    );

    // Open overlay
    fireEvent.click(screen.getByText(/27\.08/));
    expect(screen.getByRole('dialog', { name: 'Сана оралиғини танлаш' })).toBeTruthy();

    // Click Бугун
    fireEvent.click(screen.getByText('Бугун'));
    expect(handleChange).toHaveBeenCalledWith({ dateScope: 'today' });
    expect(screen.queryByRole('dialog', { name: 'Сана оралиғини танлаш' })).toBeNull();
  });

  it('shows overlay with manual inputs and preset buttons when open', () => {
    const handleChange = vi.fn();
    render(
      <DateScopeSelect
        dateScope="custom"
        dateFrom="2026-08-27"
        dateTo="2026-09-03"
        onChange={handleChange}
      />,
    );

    // Toggle open by clicking the custom label
    fireEvent.click(screen.getByText(/27\.08/));

    expect(screen.getByLabelText('Бошланғич санани қўлда киритиш')).toBeTruthy();
    expect(screen.getByLabelText('Якуний санани қўлда киритиш')).toBeTruthy();
    expect(screen.getByText('7 кун')).toBeTruthy();
    expect(screen.getByText('14 кун')).toBeTruthy();
    expect(screen.getByText('30 кун')).toBeTruthy();
    expect(screen.getByLabelText('Киритилган саналарни қўллаш')).toBeTruthy();
  });

  it('applies manual date input and calls onChange with YYYY-MM-DD format', () => {
    const handleChange = vi.fn();
    render(
      <DateScopeSelect
        dateScope="custom"
        dateFrom="2026-08-27"
        dateTo="2026-09-03"
        onChange={handleChange}
      />,
    );

    // Open overlay
    fireEvent.click(screen.getByText(/27\.08/));

    const fromInput = screen.getByLabelText('Бошланғич санани қўлда киритиш');
    const toInput = screen.getByLabelText('Якуний санани қўлда киритиш');
    const applyBtn = screen.getByLabelText('Киритилган саналарни қўллаш');

    fireEvent.change(fromInput, { target: { value: '10.08.2026' } });
    fireEvent.change(toInput, { target: { value: '20.08.2026' } });
    fireEvent.click(applyBtn);

    expect(handleChange).toHaveBeenCalledWith({
      dateScope: 'custom',
      dateFrom: '2026-08-10',
      dateTo: '2026-08-20',
    });
  });

  it('shows validation error when from date is after to date', () => {
    const handleChange = vi.fn();
    render(
      <DateScopeSelect
        dateScope="custom"
        dateFrom="2026-08-10"
        dateTo="2026-08-20"
        onChange={handleChange}
      />,
    );

    fireEvent.click(screen.getByText(/10\.08/));

    const fromInput = screen.getByLabelText('Бошланғич санани қўлда киритиш');
    const toInput = screen.getByLabelText('Якуний санани қўлда киритиш');
    const applyBtn = screen.getByLabelText('Киритилган саналарни қўллаш');

    fireEvent.change(fromInput, { target: { value: '25.08.2026' } });
    fireEvent.change(toInput, { target: { value: '10.08.2026' } });
    fireEvent.click(applyBtn);

    expect(handleChange).not.toHaveBeenCalled();
    expect(screen.getByText('Бошланғич сана якуний санадан кейин бўлиши мумкин эмас')).toBeTruthy();
  });

  it('preset buttons stage selection without auto-closing or auto-applying, and apply button enables and applies on click', () => {
    const handleChange = vi.fn();
    render(
      <DateScopeSelect
        dateScope="custom"
        dateFrom="2026-08-28"
        dateTo="2026-09-03"
        onChange={handleChange}
      />,
    );

    fireEvent.click(screen.getByText(/28\.08/));
    handleChange.mockClear();

    const applyBtn = screen.getByLabelText('Киритилган саналарни қўллаш') as HTMLButtonElement;
    // When opened matching current dates (7 days), apply button is disabled
    expect(applyBtn.disabled).toBe(true);

    const preset14 = screen.getByText('14 кун');
    fireEvent.click(preset14);

    // Overlay remains open and onChange is NOT yet called
    expect(handleChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Сана оралиғини танлаш' })).toBeTruthy();

    // Inputs are updated to 14 days
    const fromInput = screen.getByLabelText('Бошланғич санани қўлда киритиш') as HTMLInputElement;
    const toInput = screen.getByLabelText('Якуний санани қўлда киритиш') as HTMLInputElement;
    expect(fromInput.value).toBe('21.08.2026');
    expect(toInput.value).toBe('03.09.2026');

    // Apply button becomes enabled
    expect(applyBtn.disabled).toBe(false);

    // Clicking Apply fires onChange and closes the overlay
    fireEvent.click(applyBtn);
    expect(handleChange).toHaveBeenCalledWith({
      dateScope: 'custom',
      dateFrom: '2026-08-21',
      dateTo: '2026-09-03',
    });
    expect(screen.queryByRole('dialog', { name: 'Сана оралиғини танлаш' })).toBeNull();
  });

  it('closes overlay on Escape key press', () => {
    render(
      <DateScopeSelect
        dateScope="custom"
        dateFrom="2026-08-27"
        dateTo="2026-09-03"
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText(/27\.08/));
    expect(screen.getByRole('dialog', { name: 'Сана оралиғини танлаш' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Сана оралиғини танлаш' })).toBeNull();
  });

  it('supports flexible separators like slashes and hyphens', () => {
    const handleChange = vi.fn();
    render(
      <DateScopeSelect
        dateScope="custom"
        dateFrom="2026-08-27"
        dateTo="2026-09-03"
        onChange={handleChange}
      />,
    );

    fireEvent.click(screen.getByText(/27\.08/));

    const fromInput = screen.getByLabelText('Бошланғич санани қўлда киритиш');
    const toInput = screen.getByLabelText('Якуний санани қўлда киритиш');
    const applyBtn = screen.getByLabelText('Киритилган саналарни қўллаш');

    // Test slash-separated and day > 12 to ensure Day.js/V8 fallback bug is gone
    fireEvent.change(fromInput, { target: { value: '14/08/2026' } });
    fireEvent.change(toInput, { target: { value: '28/08/2026' } });
    fireEvent.click(applyBtn);

    expect(handleChange).toHaveBeenCalledWith({
      dateScope: 'custom',
      dateFrom: '2026-08-14',
      dateTo: '2026-08-28',
    });
  });

  it('highlights matching preset button with active styles', () => {
    render(
      <DateScopeSelect
        dateScope="custom"
        dateFrom="2026-08-28"
        dateTo="2026-09-03"
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText(/28\.08/));

    const preset7 = screen.getByText('7 кун').closest('button');
    const preset14 = screen.getByText('14 кун').closest('button');

    expect(preset7?.style.fontWeight).toBe('600');
    expect(preset14?.style.fontWeight).toBe('400');
    expect(preset7?.style.color).toBe('rgb(2, 132, 199)');
    expect(preset7?.style.backgroundColor).toBe('rgb(240, 249, 255)');
    expect(preset14?.style.color).toBe('rgb(71, 85, 105)');
    expect(preset14?.style.backgroundColor).toBe('rgb(248, 250, 252)');
  });

  it('renders single date label on tab when dateFrom equals dateTo', () => {
    render(
      <DateScopeSelect
        dateScope="custom"
        dateFrom="2026-09-01"
        dateTo="2026-09-01"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('01.09')).toBeTruthy();
    expect(screen.queryByText('01.09 – 01.09')).toBeNull();
  });

  it('does not show overlay initially when dateScope is not custom', () => {
    render(
      <DateScopeSelect
        dateScope="today"
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole('dialog', { name: 'Сана оралиғини танлаш' })).toBeNull();
  });
});
