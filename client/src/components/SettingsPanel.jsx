import React, { useEffect, useState } from 'react';
import { Settings, Save, RefreshCw, AlertCircle, Check } from 'lucide-react';

export function SettingsPanel() {
  const [settings, setSettings] = useState(null);
  const [rawJson, setRawJson] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [editMode, setEditMode] = useState(false);

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      setSettings(data);
      setRawJson(JSON.stringify(data, null, 2));
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  useEffect(() => { fetchSettings(); }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const parsed = JSON.parse(rawJson);
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const data = await res.json();
      setSettings(data);
      setRawJson(JSON.stringify(data, null, 2));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw size={16} className="text-ink-faint animate-spin" />
      </div>
    );
  }

  // Render settings sections
  const sections = [];
  if (settings) {
    if (settings.defaultModel || settings.model) {
      sections.push({ label: '默认模型', value: settings.defaultModel || settings.model });
    }
    if (settings.env) {
      sections.push({ label: '环境变量', value: `${Object.keys(settings.env).length} 个` });
    }
    if (settings.hooks) {
      const hookTypes = Object.keys(settings.hooks);
      sections.push({ label: 'Hooks', value: hookTypes.join(', ') });
    }
    if (settings.permissions) {
      sections.push({ label: '权限规则', value: `${Object.keys(settings.permissions).length} 条` });
    }
    if (settings.plugins) {
      sections.push({ label: '插件', value: `${Object.keys(settings.plugins).length} 个` });
    }
  }

  return (
    <div className="px-4 py-4 space-y-4 overflow-y-auto h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-medium uppercase tracking-widest text-ink-faint font-body flex items-center gap-1.5">
          <Settings size={11} />
          设置
        </h3>
        <div className="flex gap-2">
          <button
            onClick={() => setEditMode(!editMode)}
            className={`text-[10px] px-2 py-1 rounded font-body transition-colors ${
              editMode
                ? 'bg-accent/10 text-accent'
                : 'bg-canvas-warm text-ink-faint hover:text-ink-muted'
            }`}
          >
            {editMode ? '预览' : '编辑'}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-xs text-error bg-error-subtle border border-red-200 rounded-lg p-2.5">
          <AlertCircle size={13} />
          <span className="font-body">{error}</span>
        </div>
      )}

      {/* Summary view */}
      {!editMode && sections.length > 0 && (
        <div className="bg-canvas-warm border border-canvas-deep rounded-lg divide-y divide-canvas-deep">
          {sections.map((s) => (
            <div key={s.label} className="flex items-center justify-between px-3 py-2.5">
              <span className="text-xs text-ink-muted font-body">{s.label}</span>
              <span className="text-xs text-ink-soft font-mono">{s.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* JSON editor */}
      {editMode ? (
        <div className="space-y-3">
          <textarea
            value={rawJson}
            onChange={(e) => setRawJson(e.target.value)}
            className="w-full h-96 bg-canvas-warm border border-canvas-deep rounded-lg p-3 text-xs font-mono text-ink-soft resize-none focus:outline-none focus:border-accent/40 leading-relaxed"
            spellCheck={false}
          />
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-xs font-body rounded-lg transition-colors disabled:opacity-50"
            >
              {saved ? <Check size={12} /> : <Save size={12} />}
              {saved ? '已保存' : saving ? '保存中...' : '保存'}
            </button>
            <button
              onClick={() => {
                setRawJson(JSON.stringify(settings, null, 2));
                setError(null);
              }}
              className="px-3 py-1.5 bg-canvas-warm text-ink-faint text-xs font-body rounded-lg hover:text-ink-muted transition-colors"
            >
              重置
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setEditMode(true)}
          className="w-full py-2.5 bg-canvas-warm border border-canvas-deep rounded-lg text-xs text-ink-faint hover:text-ink-muted font-body transition-colors"
        >
          查看完整配置 JSON
        </button>
      )}

      {/* Refresh */}
      <button
        onClick={fetchSettings}
        className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-ink-faint hover:text-ink-muted font-body transition-colors"
      >
        <RefreshCw size={12} />
        重新加载
      </button>
    </div>
  );
}
