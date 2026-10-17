import Button from "@mui/material/Button";
import FormControlLabel from "@mui/material/FormControlLabel";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import TextField from "@mui/material/TextField";
import { formatBytes, isThemePreference, THEME_PREFERENCES, useTheme } from "@agentsim/ui";
import { useState, type InputHTMLAttributes } from "react";
import { readQuotaThreshold, writeQuotaThreshold } from "../config/environment.ts";
import { useAppActions, useServices, useStorageStatus } from "../services.tsx";

const testId = (id: string) => ({ "data-testid": id }) as InputHTMLAttributes<HTMLInputElement>;

/** Settings workspace: storage threshold, persistence, layout, theme. Providers/keys arrive in F4. */
export function SettingsPanel() {
  const { storage } = useServices();
  const { resetLayouts, setTheme } = useAppActions();
  const theme = useTheme();
  const status = useStorageStatus(storage);
  const [thresholdMb, setThresholdMb] = useState(() => Math.round(readQuotaThreshold() / (1024 * 1024)));
  const [persistMsg, setPersistMsg] = useState<string | null>(null);

  return (
    <div className="panel" data-testid="settings-panel">
      <h3>Storage</h3>
      <div className="row">
        <TextField
          id="quota-threshold"
          label="Minimum quota for persistent storage (MB)"
          type="number"
          value={thresholdMb}
          onChange={(e) => setThresholdMb(Math.max(0, Number(e.target.value) || 0))}
          slotProps={{ htmlInput: { min: 0, step: 16, className: "mono" } }}
        />
        <Button variant="outlined" color="inherit" onClick={() => writeQuotaThreshold(thresholdMb * 1024 * 1024)}>
          Save
        </Button>
      </div>
      <p className="muted">
        Below this quota (current default {formatBytes(256 * 1024 * 1024)}) the lab keeps data in memory only and asks you to export before
        closing. Applies on next reload.
      </p>
      <div className="row">
        <Button
          variant="outlined"
          color="inherit"
          disabled={status.state !== "ready"}
          onClick={async () => setPersistMsg((await storage.admin.requestPersistence()) ? "✓ persistent storage granted" : "▲ the browser declined")}
        >
          Request persistent storage
        </Button>
        {persistMsg && <span role="status">{persistMsg}</span>}
      </div>
      <h3>Layout</h3>
      <div className="row">
        <Button variant="outlined" color="inherit" onClick={resetLayouts}>
          Reset workspace layouts
        </Button>
      </div>
      <h3>Theme</h3>
      <RadioGroup row aria-label="Theme" value={theme.preference} onChange={(e) => isThemePreference(e.target.value) && setTheme(e.target.value)}>
        {THEME_PREFERENCES.map((p) => (
          <FormControlLabel
            key={p}
            value={p}
            control={<Radio size="small" slotProps={{ input: testId(`theme-${p}`) }} />}
            label={p === "system" ? `System (${theme.preference === "system" ? theme.resolved : "follows the OS"})` : p === "dark" ? "Dark" : "Light"}
          />
        ))}
      </RadioGroup>
      <p className="muted">Stored with your user data; switching never touches a running simulation.</p>
    </div>
  );
}
