import type { FormEvent } from "react";
import { Button, Input, Label } from "../components/ui";

type Props = {
  initialHospitalCode: string;
  onCreateHospital: (event: FormEvent<HTMLFormElement>) => void;
  onSetupHospitalAdmin: (event: FormEvent<HTMLFormElement>) => void;
  onResetHospitalAdminPassword: (event: FormEvent<HTMLFormElement>) => void;
  onToggleHospitalAccess: (event: FormEvent<HTMLFormElement>) => void;
};

export default function PlatformAdminPage({
  initialHospitalCode,
  onCreateHospital,
  onSetupHospitalAdmin,
  onResetHospitalAdminPassword,
  onToggleHospitalAccess,
}: Props) {
  return (
    <div className="auth-page">
      <div className="auth-card platform-admin-card">
        <h1>Platform Admin Console</h1>
        <p className="muted">Use platform onboarding credentials from backend `.env`.</p>
        <p className="hint">
          Hospital login stays on <a href="/">/</a>.
        </p>

        <form className="auth-form" onSubmit={onCreateHospital}>
          <h3>Add Hospital</h3>
          <Label>
            Platform Admin Username
            <Input name="platform_admin_username" placeholder="platform-admin" required />
          </Label>
          <Label>
            Platform Admin Password
            <Input name="platform_admin_password" type="password" placeholder="••••••••" required />
          </Label>
          <Label>
            Hospital Code
            <Input name="hospital_code" defaultValue={initialHospitalCode} required />
          </Label>
          <Label>
            Hospital Name
            <Input name="hospital_name" placeholder="City Hospital" />
          </Label>
          <Button type="submit" variant="primary">
            Add Hospital
          </Button>
        </form>

        <form className="auth-form" onSubmit={onSetupHospitalAdmin}>
          <h3>Onboard Hospital Admin</h3>
          <Label>
            Platform Admin Username
            <Input name="platform_admin_username" placeholder="platform-admin" required />
          </Label>
          <Label>
            Platform Admin Password
            <Input name="platform_admin_password" type="password" placeholder="••••••••" required />
          </Label>
          <Label>
            Hospital Code
            <Input name="hospital_code" required />
          </Label>
          <Label>
            Admin Username
            <Input name="admin_username" required />
          </Label>
          <Label>
            Admin Password
            <Input name="admin_password" type="password" required />
          </Label>
          <Label>
            Admin Full Name
            <Input name="admin_full_name" />
          </Label>
          <Label>
            Admin Email
            <Input name="admin_email" type="email" />
          </Label>
          <Label>
            Admin Phone
            <Input name="admin_phone" />
          </Label>
          <Button type="submit" variant="primary">
            Onboard Hospital Admin
          </Button>
        </form>

        <form className="auth-form" onSubmit={onResetHospitalAdminPassword}>
          <h3>Reset Hospital Admin Password</h3>
          <Label>
            Platform Admin Username
            <Input name="platform_admin_username" placeholder="platform-admin" required />
          </Label>
          <Label>
            Platform Admin Password
            <Input name="platform_admin_password" type="password" placeholder="••••••••" required />
          </Label>
          <Label>
            Hospital Code
            <Input name="hospital_code" required />
          </Label>
          <Label>
            Admin Username
            <Input name="admin_username" required />
          </Label>
          <Label>
            New Password
            <Input name="new_password" type="password" required />
          </Label>
          <Button type="submit" variant="primary">
            Reset Admin Password
          </Button>
        </form>

        <form className="auth-form" onSubmit={onToggleHospitalAccess}>
          <h3>Disable or Enable Hospital</h3>
          <Label>
            Platform Admin Username
            <Input name="platform_admin_username" placeholder="platform-admin" required />
          </Label>
          <Label>
            Platform Admin Password
            <Input name="platform_admin_password" type="password" placeholder="••••••••" required />
          </Label>
          <Label>
            Hospital Code
            <Input name="hospital_code" required />
          </Label>
          <Label>
            Action (disable or enable)
            <Input name="action" placeholder="disable" required />
          </Label>
          <Label>
            Reason (for disable)
            <Input name="reason" placeholder="Policy violation" />
          </Label>
          <Button type="submit" variant="primary">
            Update Hospital Access
          </Button>
        </form>
      </div>
    </div>
  );
}
