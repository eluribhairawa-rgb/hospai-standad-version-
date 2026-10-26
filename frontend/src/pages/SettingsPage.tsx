import { useEffect, useState } from "react";
import { Button, Input, Table, TableCell, TableHead, TableRow } from "../components/ui";
import { apiFetch } from "../lib/api";
import { formatDateTime } from "../lib/format";
import type { AuditLog, Stats, User } from "../types";

type Props = {
  stats: Stats;
  user: User;
  canReadAudit: boolean;
};

export default function SettingsPage({ stats, user, canReadAudit }: Props) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [auditModule, setAuditModule] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadAuditLogs = async (moduleName = auditModule) => {
    if (!canReadAudit) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (moduleName.trim()) params.set("module", moduleName.trim());
      const data = await apiFetch<{ logs?: AuditLog[] }>(`/api/audit/logs?${params.toString()}`);
      setLogs(data.logs || []);
    } catch (loadError) {
      const typedError = loadError as { message?: string; status?: number };
      setError(typedError.message || "Unable to load audit logs.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (canReadAudit) {
      void loadAuditLogs("");
    }
  }, [canReadAudit]);

  return (
    <section className="module-page">
      <div className="settings-grid">
        <div className="panel">
          <h3>Database Snapshot</h3>
          <pre>{JSON.stringify(stats, null, 2)}</pre>
        </div>
        <div className="panel">
          <h3>Current User</h3>
          <pre>{JSON.stringify(user, null, 2)}</pre>
        </div>
      </div>

      <div className="panel">
        <div className="module-panel-head">
          <div>
            <h3>Audit Trail</h3>
            <p className="muted">Recent system actions, filtered by module when needed.</p>
          </div>
        </div>
        {!canReadAudit ? (
          <p className="muted">Audit log access is restricted to admins with audit permission.</p>
        ) : (
          <>
            <div className="patient-toolbar">
              <Input
                value={auditModule}
                onChange={(event) => setAuditModule(event.target.value)}
                placeholder="Filter by module name (e.g. billing_invoices)"
              />
              <Button type="button" onClick={() => void loadAuditLogs(auditModule)}>
                Apply
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setAuditModule("");
                  void loadAuditLogs("");
                }}
              >
                Clear
              </Button>
              <span className="muted">{loading ? "Loading..." : `${logs.length} rows`}</span>
            </div>
            {error ? <p className="notice error">{error}</p> : null}
            {!loading && !error && logs.length === 0 ? <p className="muted">No audit log entries available.</p> : null}
            {!loading && !error && logs.length > 0 ? (
              <>
                <Table className="module-table" aria-label="Audit logs table">
                  <TableHead>
                    <TableCell>When</TableCell>
                    <TableCell>Actor</TableCell>
                    <TableCell>Action</TableCell>
                    <TableCell>Module</TableCell>
                    <TableCell>Record</TableCell>
                    <TableCell>Details</TableCell>
                  </TableHead>
                  {logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell>{formatDateTime(log.created_at)}</TableCell>
                      <TableCell>{log.actor_username || "-"}</TableCell>
                      <TableCell>{log.action || "-"}</TableCell>
                      <TableCell>{log.module_name || "-"}</TableCell>
                      <TableCell>{log.entity_key || "-"}</TableCell>
                      <TableCell>{log.payload || "-"}</TableCell>
                    </TableRow>
                  ))}
                </Table>
                <div className="module-mobile-list" style={{ display: "grid" }} aria-label="Audit log cards">
                  {logs.map((log) => (
                    <article className="module-mobile-card" key={`audit-${log.id}`}>
                      <h4>{log.module_name || "Audit Event"}</h4>
                      <p><strong>When:</strong> {formatDateTime(log.created_at)}</p>
                      <p><strong>Actor:</strong> {log.actor_username || "-"}</p>
                      <p><strong>Action:</strong> {log.action || "-"}</p>
                      <p><strong>Record:</strong> {log.entity_key || "-"}</p>
                      <p><strong>Details:</strong> {log.payload || "-"}</p>
                    </article>
                  ))}
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
