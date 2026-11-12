// Loaded by the DSH browser module loader; React and configuration storage belong to the host.
window.__ModuleLoader__.load({
  id: '@software-factory/runtime',
  factory(require) {
    const React = require('react'), h = React.createElement;
    const words = {
      zh: { title: '执行时限配置', intro: '通常保留默认值即可。时间单位为分钟，保存后用于新任务。',
        task: '任务最长运行时间（分钟）', taskHint: '包含算法、所有模型调用及产物生成；默认60分钟（1小时），等待用户回答不计入。',
        model: '单次模型请求最长时间（分钟）', modelHint: '每次模型请求的总时限；默认8分钟，持续输出也计入时间。',
        save: '保存', discard: '放弃修改', saving: '正在保存…', saved: '已保存，无需重启；运行中的任务保持原时限。',
        invalid: '请输入1秒至120分钟之间的时间，可以填写小数分钟。', loading: '正在读取配置…',
        unavailable: '请启用软件工厂执行服务及DSH原生设置服务。', readOnly: '当前连接没有保存配置的权限。',
        conflict: '配置已在其他页面修改，请放弃修改后重新填写。', failed: '保存失败，请检查服务端提示。',
        dirty: '有未保存的修改', usage: '无需填写环境变量或修改配置文件。单次启动提供timeoutMs时，仍可覆盖该任务的整体时限。' },
      en: { title: 'Execution time limits', intro: 'Defaults usually suffice. Enter minutes; saved values apply to new tasks.',
        task: 'Task time limit (minutes)', taskHint: 'Includes the algorithm, model calls and output generation. Default: 60 minutes (1 hour); excludes human waiting.',
        model: 'Model request time limit (minutes)', modelHint: 'Total time per request, including streamed output. Default: 8 minutes.',
        save: 'Save', discard: 'Discard changes', saving: 'Saving…', saved: 'Saved without restarting. Running tasks retain their time limits.',
        invalid: 'Enter a duration from 1 second to 120 minutes. Fractional minutes are allowed.', loading: 'Loading configuration…',
        unavailable: 'Enable Runtime and the native DSH settings service.', readOnly: 'This connection cannot save configuration.',
        conflict: 'Another page changed the configuration. Discard changes and edit again.', failed: 'Could not save. Check the server message.',
        dirty: 'Unsaved changes', usage: 'No environment variable or configuration file editing is needed. A task timeoutMs can still override its total limit.' },
    };
    const format = value => ({ defaultTimeoutMs: String(value.defaultTimeoutMs / 60000), modelTimeoutMs: String(value.modelTimeoutMs / 60000) });
    function Configuration({ scope, t }) {
      const observer = React.useMemo(() => ({ subscribe: fn => scope.subscribe(fn), get: () => scope.getSnapshot() }), [scope]);
      const state = React.useSyncExternalStore(observer.subscribe, observer.get, observer.get);
      const [draft, setDraft] = React.useState(null), [baseline, setBaseline] = React.useState(null);
      const [revision, setRevision] = React.useState(), [saving, setSaving] = React.useState(false);
      const [notice, setNotice] = React.useState(''), [error, setError] = React.useState('');
      const id = React.useId();
      const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(baseline);
      const conflict = dirty && revision !== state.revision;
      React.useEffect(() => {
        if (state.status === 'ready' && state.value && !dirty && !saving) {
          const next = format(state.value); setDraft(next); setBaseline(next); setRevision(state.revision);
        }
      }, [state.status, state.value, state.revision, dirty, saving]);
      const disabled = saving || !state.writable || state.status !== 'ready';
      function discard() {
        const current = scope.getSnapshot(); if (!current.value) return;
        const next = format(current.value); setDraft(next); setBaseline(next); setRevision(current.revision); setError(''); setNotice('');
      }
      async function save(event) {
        event.preventDefault(); if (disabled || !dirty || conflict) return;
        const values = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, Math.round(Number(value) * 60000)]));
        if (Object.values(draft).some(value => !value.trim()) || Object.values(values).some(value => !Number.isFinite(value) || value < 1000 || value > 7200000)) { setError(t('invalid')); return; }
        setSaving(true); setError(''); setNotice('');
        try {
          const accepted = await scope.mutate(Object.entries(values).map(([key, value]) => ({ op: 'set', path: [key], value })), revision);
          if (accepted) {
            const current = scope.getSnapshot(), next = format(current.value ?? values);
            setDraft(next); setBaseline(next); setRevision(current.revision); setNotice(t('saved'));
          } else setError(t(scope.getSnapshot().revision !== revision ? 'conflict' : 'failed'));
        } catch (reason) { setError(t('failed') + (reason?.message ? ' ' + reason.message : '')); }
        finally { setSaving(false); }
      }
      function field(key, title, hint) {
        return h('div', { key }, h('label', { htmlFor: id + key }, t(title)),
          h('input', { id: id + key, name: key, type: 'number', min: 1 / 60, max: 120, step: 'any', value: draft[key], disabled,
            'aria-describedby': id + key + '-hint', onChange: event => { setDraft({ ...draft, [key]: event.target.value }); setError(''); setNotice(''); } }),
          h('p', { id: id + key + '-hint' }, t(hint)));
      }
      return h('form', { className: 'sf-runtime-settings', onSubmit: save, noValidate: true },
        h('style', null, '.sf-runtime-settings{display:flex;flex-direction:column;gap:20px;color:var(--dsw-alias-label-primary);font-size:14px}.sf-runtime-settings h4{margin:0;font-size:16px}.sf-runtime-settings p{font-size:13px;color:var(--dsw-alias-label-secondary);margin:6px 0}.sf-runtime-settings label{display:block;margin-bottom:8px}.sf-runtime-settings input{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:inherit;font:inherit}.sf-runtime-settings footer{display:flex;gap:12px}.sf-runtime-settings button{padding:8px 16px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:inherit;font:inherit;cursor:pointer}.sf-runtime-settings button[type=submit]{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.sf-runtime-settings button:disabled{opacity:.4;cursor:default}.sf-runtime-settings [role=alert]{color:var(--dsw-alias-label-error)}'),
        h('header', null, h('h4', null, t('title')), h('p', null, t('intro'))),
        state.status !== 'ready' || !draft ? h('p', { role: 'status' }, t(state.status === 'loading' ? 'loading' : 'unavailable')) : h(React.Fragment, null,
          !state.writable && h('p', { role: 'status' }, t('readOnly')),
          field('defaultTimeoutMs', 'task', 'taskHint'), field('modelTimeoutMs', 'model', 'modelHint'), h('p', null, t('usage')),
          (error || conflict) && h('p', { role: 'alert' }, error || t('conflict')),
          h('footer', null, h('button', { type: 'submit', disabled: disabled || !dirty || conflict }, t(saving ? 'saving' : 'save')),
            h('button', { type: 'button', disabled: saving || !dirty, onClick: discard }, t('discard'))),
          h('p', { role: 'status' }, notice || (dirty ? t('dirty') : ''))));
    }
    return { inject: ['slots', 'locale', 'configForms'], apply(ctx) {
      ctx.effect(() => ctx.locale.register('softwareFactoryRuntimeSettings', words));
      const scope = ctx.configForms.get('sf-runtime');
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: '@software-factory/runtime',
        locale: 'softwareFactoryRuntimeSettings', inject: () => ({ scope }) }, Configuration));
    } };
  },
});
