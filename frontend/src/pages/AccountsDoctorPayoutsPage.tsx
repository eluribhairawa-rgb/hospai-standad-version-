import type { Dispatch, SetStateAction } from "react";
import AccountsPage from "./AccountsPage";
import type { Notice } from "../types";

type Props = {
  setNotice: Dispatch<SetStateAction<Notice | null>>;
};

export default function AccountsDoctorPayoutsPage({ setNotice }: Props) {
  return <AccountsPage setNotice={setNotice} view="doctor-payouts" />;
}
