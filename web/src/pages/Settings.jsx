import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../toast';
import { Button, Card, PageHeader, Pill } from '../components/ui';
import RecordForm from '../components/RecordForm';

const PROFILE = [
  { key: 'company_name', label: 'Company name', type: 'text', required: true },
  { key: 'company_name_ar', label: 'Company name (Arabic)', type: 'text' },
  { key: 'tagline', label: 'Tagline', type: 'text', span: 2 },
  { key: 'support_email', label: 'Support email', type: 'email' },
  { key: 'support_phone', label: 'Support phone', type: 'tel' },
  { key: 'default_branch', label: 'Default branch', type: 'relation', relation: 'branches', span: 2 },
];
const BILLING = [
  { key: 'trn', label: 'Tax registration number (TRN)', type: 'text', span: 2 },
  { key: 'vat_rate', label: 'VAT rate', type: 'number', suffix: '%', min: 0, max: 100, step: 0.5 },
  { key: 'currency', label: 'Currency', type: 'text', readOnly: true },
  { key: 'fine_admin_fee', label: 'Admin fee per traffic fine', type: 'number', suffix: 'AED', min: 0, step: 0.5 },
  { key: 'salik_admin_fee', label: 'Admin fee per Salik toll', type: 'number', suffix: 'AED', min: 0, step: 0.5 },
];

export default function Settings() {
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('settings.edit');
  const [values, setValues] = useState(null);
  const [saved, setSaved] = useState(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  useEffect(() => { api.get('/settings').then((s) => { setValues(s); setSaved(s); }).catch((e) => toast.error(e.message)); }, [toast]);

  const dirty = values && saved && Object.keys(values).some((k) => String(values[k] ?? '') !== String(saved[k] ?? ''));
  const onChange = (key, value) => { setValues((v) => ({ ...v, [key]: value })); setErrors((e) => ({ ...e, [key]: undefined })); };

  const save = async () => {
    const errs = {};
    if (!String(values.company_name || '').trim()) errs.company_name = 'Company name is required';
    const vat = Number(values.vat_rate);
    if (values.vat_rate === '' || Number.isNaN(vat) || vat < 0 || vat > 100) errs.vat_rate = 'Enter a rate between 0 and 100';
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setSaving(true);
    try {
      const next = await api.put('/settings', values);
      setValues(next);
      setSaved(next);
      toast.success('Settings saved');
    } catch (e) { toast.error(e.message); } finally { setSaving(false); }
  };

  return (
    <>
      <PageHeader title="Settings" subtitle="Company profile, tax and fee defaults.">
        {canEdit ? <Button variant="primary" arrow loading={saving} disabled={!dirty} onClick={save}>Save changes</Button> : <Pill tone="neutral" dot={false}>View only for your role</Pill>}
      </PageHeader>
      {!values ? (
        <div className="card card-pad"><span className="skel" style={{ width: '40%', marginBottom: 14 }} /><span className="skel" style={{ width: '80%' }} /></div>
      ) : (
        <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} className="col">
        <div className="col" style={{ gap: 18, maxWidth: 860 }}>
          <Card title="Company profile" sub="Shown on documents and customer messages.">
            <RecordForm fields={PROFILE} values={values} onChange={onChange} errors={errors} />
          </Card>
          <Card title="Tax and fees" sub="Used when new bookings, invoices and fines are created.">
            <RecordForm fields={BILLING} values={values} onChange={onChange} errors={errors} />
          </Card>
        </div>
        </fieldset>
      )}
    </>
  );
}
