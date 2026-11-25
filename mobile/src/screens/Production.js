import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import * as api from '../api';
import { ask, notify } from '../dialog';
import { Btn, Chip, Err, Header, fmtDT, kioskField, toNumber, useLoad } from '../components';
import { C, fmtQty, s } from '../ui';

// Stages (Yaya 2.0, stage 10): every person runs the stages they are responsible
// for. A stage shows what is waiting in the stage before it; a "change" stage makes
// something new from its recipe (materials are taken by themselves from the
// warehouses the person keeps), a "keep" stage moves the same product on. The
// technologist sees the shift's milk at the top, with separation (entered at the
// end of the shift). "Who did it with you" decides the piece wages.
// No sums anywhere — the server does not send them to staff.

const prod = (method, path, body, opts) => api.erp(method, `/prod${path}`, body, opts);
export const canProduce = () => api.canAny('prod.work', 'prod.pour', 'prod.cap', 'prod.reprocess', 'prod.manage', 'stock.transfer');
const PER_UNIT = new Set(['pour', 'pack', 'cap', 'reprocess']);

const TASK = { open: ['Jarayonda', C.warn], approval: ['Rahbar tasdig\'ini kutmoqda', C.warn], done: ['Bajarildi', C.ok], cancelled: ['Bekor qilingan', C.err] };
function Badge({ map, status }) {
  const [t, color] = map[status] ?? [status, C.muted];
  return <View style={{ borderWidth: 1, borderColor: color, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' }}><Text style={{ color, fontSize: 13, fontWeight: '600' }}>{t}</Text></View>;
}
const weightKg = (unit, qty) => { const u = String(unit || 'kg').toLowerCase(); return u === 'g' || u === 'gramm' ? qty / 1000 : u === 'dona' ? 0 : qty; };
const r3 = (n) => Math.round(n * 1000) / 1000;

function Num({ value, onChange, unit, width = 120, placeholder = '0' }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <TextInput style={[s.input, { width, paddingVertical: 8, fontSize: 18, textAlign: 'right' }]} keyboardType="decimal-pad" value={String(value ?? '')}
        {...kioskField(value, onChange)} placeholder={placeholder} placeholderTextColor={C.placeholder} />
      {!!unit && <Text style={[s.muted, { minWidth: 30 }]}>{unit}</Text>}
    </View>
  );
}

// "Who did it with you?" — the person doing it is ticked; others can be added.
function Workers({ staff, team, setTeam }) {
  const me = api.me();
  return (
    <View style={[s.card, { gap: 8 }]}>
      <Text style={s.muted}>Bu ishni kim bilan qildingiz? (ishbay haq teng bo'linadi)</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {(staff ?? []).map((u) => (
          <Chip key={u.id} label={u.id === me?.id ? `${u.name} (men)` : u.name} on={team.includes(u.id)}
            onPress={() => setTeam(team.includes(u.id) ? (team.length > 1 ? team.filter((x) => x !== u.id) : team) : [...team, u.id])} />
        ))}
      </View>
      <Text style={s.muted}>{team.length} kishi</Text>
    </View>
  );
}

// ---------------------------------------------------------------- my stages
export function Production({ tick, onTask, onNew, onClose, onMove }) {
  const { data, err, busy, load } = useLoad(() => prod('GET', '/board'), [tick]);
  const stages = data?.stages ?? [];
  const sh = data?.shift;
  const produce = stages.find((x) => x.code === 'produce');
  const skimUsed = (sh?.separation?.outputs ?? []).filter((o) => o.book < -0.0005);
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}>
      <Err err={err} />
      {data && !stages.length && (
        <View style={[s.card, { gap: 6 }]}>
          <Text style={s.h2}>Bosqich biriktirilmagan</Text>
          <Text style={s.muted}>Rahbar sizni bosqichga mas'ul qilib belgilasin (panel → Ishlab chiqarish → Bosqichlar).</Text>
        </View>
      )}
      {produce && (
        <View style={[s.card, { gap: 6, borderColor: C.accent }]}>
          <Text style={s.h2}>Smena{sh ? ` · ${sh.label}` : ''}</Text>
          {sh ? (
            <>
              <Text style={s.text}>Sarflangan sut: <Text style={{ fontWeight: '700', fontSize: 20 }}>{fmtQty(sh.milk.used)} kg</Text></Text>
              <Text style={s.muted}>"{sh.milk.warehouse}"da hisobda: {fmtQty(sh.milk.book)} kg · ochildi {fmtDT(sh.opened_at)}</Text>
              {sh.status === 'approval' && <Text style={{ color: C.warn }}>Smena yakuni rahbar tasdig'ini kutmoqda</Text>}
              {!!sh.approval_note && <Text style={{ color: C.err }}>Rahbar: {sh.approval_note}</Text>}
            </>
          ) : <Text style={s.muted}>Birinchi topshiriq boshlanganda smena o'zi ochiladi.</Text>}
          {/* Separation: entered at the end of the shift; skim milk / cream used so far is shown */}
          <View style={{ borderTopWidth: 1, borderColor: C.line, paddingTop: 8, gap: 4 }}>
            <Text style={[s.text, { fontWeight: '700' }]}>Separatsiya</Text>
            {skimUsed.length ? skimUsed.map((o) => <Text key={o.product_id} style={{ color: C.warn }}>{o.product}: {fmtQty(-o.book)} {o.unit} ishlatildi — smena oxirida kiritasiz</Text>)
              : <Text style={s.muted}>Qaymoq va yog'siz sut miqdori smena oxirida kiritiladi.</Text>}
          </View>
          {sh?.status === 'open' && <Btn title="Separatsiya va smenani yopish" kind="ghost" onPress={onClose} />}
        </View>
      )}
      {(data?.tasks ?? []).map((t) => (
        <Pressable key={t.id} onPress={() => onTask(t.id)} style={({ pressed }) => [s.card, { gap: 4, borderColor: C.warn }, pressed && { opacity: 0.6 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <Text style={[s.text, { fontWeight: '700', flex: 1 }]}>{t.label} · {t.recipe ?? t.stage}</Text>
            <Badge map={TASK} status={t.status} />
          </View>
          <Text style={s.muted}>{t.plan.map((l) => `${l.product} ${fmtQty(l.qty)} ${l.unit}`).join(' · ')}</Text>
          {!!t.approval_note && t.status === 'open' && <Text style={{ color: C.err }}>Rad etildi: {t.approval_note}</Text>}
        </Pressable>
      ))}
      {stages.map((st) => (
        <View key={st.id} style={[s.card, { gap: 8 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={s.h2}>{st.name}</Text>
            <Text style={s.muted}>{st.type_label}</Text>
          </View>
          {st.type === 'change' ? (
            st.waiting.map((w) => (
              <Pressable key={w.recipe_id} onPress={() => onNew({ stageId: st.id, recipeId: w.recipe_id })}
                style={({ pressed }) => [{ paddingVertical: 10, borderTopWidth: 1, borderColor: C.line, gap: 2 }, pressed && { opacity: 0.6 }]}>
                <Text style={[s.text, { fontWeight: '600' }]}>{w.recipe}{w.product ? ` → ${w.product}` : ''}</Text>
                {w.waiting ? <Text style={{ color: w.waiting.qty > 0 ? C.ok : C.muted }}>{w.waiting.from_name}da: {fmtQty(w.waiting.qty)} {w.waiting.unit} {w.waiting.product}</Text> : null}
              </Pressable>
            )).concat(st.waiting.length ? [] : [<Text key="none" style={s.muted}>Bu bosqichda tarkib yo'q</Text>])
          ) : (
            st.waiting.length ? st.waiting.map((w) => (
              <Pressable key={w.product_id} onPress={() => onMove({ stage: st, item: w })}
                style={({ pressed }) => [{ paddingVertical: 10, borderTopWidth: 1, borderColor: C.line, gap: 2 }, pressed && { opacity: 0.6 }]}>
                <Text style={[s.text, { fontWeight: '600' }]}>{w.product}</Text>
                <Text style={{ color: C.ok }}>{w.from_name}da kutmoqda: {fmtQty(w.qty)} {w.unit}</Text>
              </Pressable>
            )) : <Text style={s.muted}>Oldingi bosqichda kutayotgan mahsulot yo'q</Text>
          )}
          {!!st.contents.length && (
            <View style={{ borderTopWidth: 1, borderColor: C.line, paddingTop: 6 }}>
              <Text style={s.muted}>Shu bosqichda turibdi:</Text>
              {st.contents.map((c) => <Text key={c.product_id} style={{ color: c.qty < 0 ? C.err : C.text }}>{c.product}: {fmtQty(c.qty)} {c.unit}</Text>)}
            </View>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

// ---------------------------------------------------------------- start a task at a 'change' stage
export function NewTask({ stageId, recipeId, onBack, onDone }) {
  const { data: r, err } = useLoad(() => prod('GET', `/recipes/${recipeId}`), [recipeId]);
  const [milk, setMilk] = useState('');
  const [factor, setFactor] = useState('');
  const [over, setOver] = useState({});
  const [busy, setBusy] = useState(false);
  const perUnit = r && PER_UNIT.has(r.kind);
  const f = r ? (r.base_milk > 0 && !perUnit ? toNumber(milk || 0) / r.base_milk : toNumber(factor || 0)) : 0;
  const lines = r ? r.lines.map((l) => {
    const o = over[l.id] ?? {};
    const pid = o.productId ?? l.product_id;
    // the chosen product: the line itself, an alternative, or a variant of either
    const alt = l.alts.find((a) => a.product_id === pid || a.variants.some((v) => v.id === pid));
    const base = alt ?? l;
    const variant = base.variants?.find((v) => v.id === pid);
    const auto = Math.round((alt?.qty ?? l.qty) * f * 1000) / 1000;
    return { l, base, pid, name: variant?.name ?? base.product, unit: base.unit, variants: base.variants ?? [], qty: o.qty ?? (f > 0 ? String(auto) : ''), auto };
  }) : [];
  const start = async () => {
    setBusy(true);
    try {
      const t = await prod('POST', '/tasks', {
        uuid: randomUUID(), stageId, recipeId: r.id, ...(perUnit ? { units: toNumber(factor) } : r.base_milk > 0 ? { milkQty: toNumber(milk) } : { factor: toNumber(factor) }),
        lines: lines.map((x) => ({ lineId: x.l.id, productId: x.pid, ...(x.qty !== String(x.auto) ? { qty: toNumber(x.qty) } : {}) })),
      }, { idempotent: true });
      onDone(t.id);
    } catch (e) { notify('Xatolik', e.message); } finally { setBusy(false); }
  };
  return (
    <View style={{ flex: 1 }}>
      <Header title={r ? r.name : 'Topshiriq'} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Err err={err} />
        {r && (
          <View style={[s.card, { gap: 8 }]}>
            {r.base_milk > 0 && !perUnit ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={s.text}>Necha kg sut?</Text>
                <Num value={milk} onChange={setMilk} unit="kg" />
              </View>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={s.text}>{perUnit ? 'Nechta dona?' : 'Necha partiya?'}</Text>
                <Num value={factor} onChange={setFactor} unit={perUnit ? 'dona' : '×'} />
              </View>
            )}
            <Text style={s.muted}>Tarkib bo'yicha (shu partiya uchun o'zgartirish mumkin):</Text>
            {lines.map((x) => (
              <View key={x.l.id} style={{ gap: 6, paddingVertical: 6, borderBottomWidth: 1, borderColor: C.line }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <Text style={[s.text, { flex: 1 }]}>{x.name}</Text>
                  <Num value={x.qty} unit={x.unit} onChange={(v) => setOver((o) => ({ ...o, [x.l.id]: { ...(o[x.l.id] ?? {}), qty: v } }))} />
                </View>
                {x.l.alts.length > 0 && (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {[{ product_id: x.l.product_id, product: x.l.product }, ...x.l.alts].map((a) => (
                      <Chip key={a.product_id} label={a.product} on={a.product_id === x.base.product_id}
                        onPress={() => setOver((o) => ({ ...o, [x.l.id]: { productId: a.product_id } }))} />
                    ))}
                  </View>
                )}
                {/* "Zakvaska" first, then its variant: 499, 505... */}
                {x.variants.length > 0 && (
                  <View style={{ gap: 4 }}>
                    <Text style={s.muted}>Qaysi varianti?</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      {x.variants.map((v) => <Chip key={v.id} label={v.variant} on={v.id === x.pid}
                        onPress={() => setOver((o) => ({ ...o, [x.l.id]: { ...(o[x.l.id] ?? {}), productId: v.id } }))} />)}
                    </View>
                    {!x.variants.some((v) => v.id === x.pid) && <Text style={{ color: C.warn, fontSize: 13 }}>Tanlanmasa — omborda ko'pi olinadi</Text>}
                  </View>
                )}
              </View>
            ))}
            <Btn title={busy ? '...' : 'Boshlash'} onPress={start} disabled={busy || !(f > 0)} />
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------- finish a task
export function TaskScreen({ id, onBack, onDone }) {
  const { data, err, load } = useLoad(async () => {
    const t = await prod('GET', `/tasks/${id}`);
    const [r, meta] = await Promise.all([t.recipe_id ? prod('GET', `/recipes/${t.recipe_id}`) : null, api.erp('GET', '/meta')]);
    return { t, r, meta };
  }, [id]);
  const me = api.me();
  const [workers, setWorkers] = useState(null);
  const [qty, setQty] = useState({});
  const [out, setOut] = useState({});
  const [busy, setBusy] = useState(false);
  const t = data?.t; const r = data?.r; const meta = data?.meta;
  const perUnit = r && PER_UNIT.has(r.kind);
  const team = workers ?? [me?.id];
  const inputs = useMemo(() => (t ? t.plan.map((l) => ({ ...l, qty: qty[l.productId] ?? String(l.qty) })) : []), [t, qty]);
  if (!t) return <View style={{ flex: 1 }}><Header title="Topshiriq" onBack={onBack} /><Err err={err} /></View>;
  if (r?.kind === 'reprocess') return <ReprocessTask t={t} r={r} onBack={onBack} onDone={onDone} reload={load} />;
  const inWeight = inputs.reduce((a, l) => a + weightKg(l.unit, toNumber(l.qty || 0)), 0);
  const scale = r?.base_weight > 0 ? inWeight / r.base_weight : 1;
  // Conditional limit: when all its products are used, its range applies (most specific wins).
  const used = new Set(inputs.filter((l) => toNumber(l.qty || 0) > 0).map((l) => Number(l.productId)));
  const rule = (r?.limits ?? []).filter((x) => x.product_ids.every((pid) => used.has(pid))).sort((x, y) => y.product_ids.length - x.product_ids.length)[0] ?? null;
  const lo = rule ? rule.out_min : r?.out_min; const hi = rule ? rule.out_max : r?.out_max;
  const range = r && !PER_UNIT.has(r.kind) && (lo != null || hi != null) ? { min: lo == null ? null : lo * scale, max: hi == null ? null : hi * scale, rule: rule ? (rule.name || rule.products.join(' + ')) : null } : null;
  const outs = r?.kind === 'separation' ? r.outputs.map((o) => ({ productId: o.product_id, name: o.product, unit: o.unit })) : [{ productId: r?.product_id, name: r?.product, unit: r?.unit }];
  const outWeight = perUnit ? toNumber(out[r.product_id] ?? String(t.factor)) : outs.reduce((a, o) => a + weightKg(o.unit, toNumber(out[o.productId] || 0)), 0);
  const outside = range && outWeight > 0 && ((range.min != null && outWeight < range.min - 0.0005) || (range.max != null && outWeight > range.max + 0.0005));
  const editable = t.status === 'open';

  const finish = async () => {
    setBusy(true);
    try {
      const body = { lines: inputs.map((l) => ({ productId: l.productId, qty: toNumber(l.qty) })), workers: team };
      if (r.kind !== 'separation') body.outputQty = toNumber(out[r.product_id] ?? (perUnit ? String(t.factor) : 0));
      else body.outputs = outs.map((o) => ({ productId: o.productId, qty: toNumber(out[o.productId] || 0) }));
      const res = await prod('POST', `/tasks/${t.id}/complete`, body);
      onDone(res.needApproval ? `${t.label}: chiqish limitdan tashqarida — rahbar tasdig'iga yuborildi` : `${t.label} bajarildi`);
    } catch (e) { notify('Xatolik', e.message); load(); } finally { setBusy(false); }
  };
  const cancel = () => ask('Bekor qilish', `${t.label} bekor qilinsinmi? Ishlatilgan mahsulot qayerdan olingan bo'lsa, o'sha yerga qaytadi.`, 'Ha', async () => {
    try { await prod('POST', `/tasks/${t.id}/cancel`, { reason: 'Xodim bekor qildi' }); onDone(`${t.label} bekor qilindi`); } catch (e) { notify('Xatolik', e.message); }
  });

  return (
    <View style={{ flex: 1 }}>
      <Header title={`${t.label} · ${t.recipe}`} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Badge map={TASK} status={t.status} />
        {!!t.approval_note && <Text style={{ color: t.status === 'open' ? C.err : C.muted }}>Rahbar: {t.approval_note}</Text>}
        <View style={[s.card, { gap: 4 }]}>
          <Text style={[s.muted, { marginBottom: 4 }]}>Ishlatildi (ombordan o'zi ayriladi)</Text>
          {inputs.map((l) => (
            <View key={l.productId} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 }}>
              <Text style={[s.text, { flex: 1 }]}>{l.product}</Text>
              {editable ? <Num value={l.qty} unit={l.unit} onChange={(v) => setQty((q) => ({ ...q, [l.productId]: v }))} />
                : <Text style={[s.text, { fontWeight: '700' }]}>{fmtQty((t.result?.lines ?? []).find((x) => x.productId === l.productId)?.qty ?? l.qty)} {l.unit}</Text>}
            </View>
          ))}
        </View>
        <View style={[s.card, { gap: 6 }]}>
          <Text style={s.muted}>{r?.kind === 'separation' ? 'Nima chiqdi (tarozida)' : perUnit ? 'Nechta chiqdi' : 'Tayyor quyma og\'irligi (tarozida)'}</Text>
          {t.status === 'done' ? t.outputs.map((o) => <Text key={o.product_id} style={s.text}>{o.product}: <Text style={{ fontWeight: '700' }}>{fmtQty(o.qty)} {o.unit}</Text></Text>) : outs.map((o) => (
            <View key={o.productId} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={[s.text, { flex: 1 }]}>{o.name}</Text>
              {editable ? <Num value={out[o.productId] ?? (perUnit ? String(t.factor) : '')} unit={o.unit} onChange={(v) => setOut((x) => ({ ...x, [o.productId]: v }))} /> : null}
            </View>
          ))}
          {range && editable && <Text style={{ color: outside ? C.err : C.muted }}>Ruxsat etilgan: {fmtQty(range.min ?? 0)} – {range.max == null ? '∞' : fmtQty(range.max)} kg{range.rule ? ` (shartli: ${range.rule})` : ''}{outside ? ' — chegaradan tashqarida, rahbar tasdiqlaydi' : ''}</Text>}
          {t.status === 'approval' && <Text style={{ color: C.warn }}>Chiqish chegaradan tashqarida. Rahbar tasdiqlashini kuting.</Text>}
        </View>
        {editable && <Workers staff={meta?.staff} team={team} setTeam={setWorkers} />}
        {editable && <Btn title={busy ? '...' : 'Yakunlash'} onPress={finish} disabled={busy || !(outWeight > 0 || outs.some((o) => toNumber(out[o.productId] || 0) > 0))} />}
        {(t.status === 'open' || t.status === 'done' || t.status === 'approval') && <Btn title="Bekor qilish" kind="warn" onPress={cancel} />}
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------- a 'keep' stage: move on
export function MoveScreen({ stage, item, onBack, onDone }) {
  const { data: meta } = useLoad(() => api.erp('GET', '/meta'), []);
  const me = api.me();
  const [qty, setQty] = useState(String(item.qty));
  const [workers, setWorkers] = useState(null);
  const [busy, setBusy] = useState(false);
  const team = workers ?? [me?.id];
  const q = toNumber(qty || 0);
  const more = q > item.qty + 0.0005;
  const save = async () => {
    setBusy(true);
    try {
      await prod('POST', '/moves', { uuid: randomUUID(), stageId: stage.id, productId: item.product_id, qty: q, workers: team }, { idempotent: true });
      onDone(`${stage.name}: ${fmtQty(q)} ${item.unit} ${item.product}`);
    } catch (e) { notify('Xatolik', e.message); } finally { setBusy(false); }
  };
  return (
    <View style={{ flex: 1 }}>
      <Header title={stage.name} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        <View style={[s.card, { gap: 8 }]}>
          <Text style={[s.text, { fontWeight: '700' }]}>{item.product}</Text>
          <Text style={s.muted}>{item.from_name}da: {fmtQty(item.qty)} {item.unit}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={s.text}>Nechtasi?</Text>
            <Num value={qty} onChange={setQty} unit={item.unit} />
          </View>
          {more && <Text style={{ color: C.err }}>"{item.from_name}"da hisobdagidan ko'p — u manfiyga tushadi va rahbarga xabar boradi</Text>}
          {q > 0 && q < item.qty - 0.0005 && <Text style={s.muted}>Qolgan {fmtQty(r3(item.qty - q))} {item.unit} "{item.from_name}"da qoladi</Text>}
        </View>
        {!!stage.piece_rate && <Workers staff={meta?.staff} team={team} setTeam={setWorkers} />}
        <Btn title={busy ? '...' : 'Tasdiqlash'} onPress={save} disabled={busy || !(q > 0)} />
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------- separation and the end of the shift
export function CloseShift({ onBack, onDone }) {
  const { data, err } = useLoad(async () => {
    const [{ shift }, meta] = await Promise.all([prod('GET', '/shift'), api.erp('GET', '/meta')]);
    return { shift, meta };
  }, []);
  const [left, setLeft] = useState('');
  const [loss, setLoss] = useState({});
  const [sep, setSep] = useState({});
  const [busy, setBusy] = useState(false);
  if (!data?.shift) return <View style={{ flex: 1 }}><Header title="Smenani yopish" onBack={onBack} /><Err err={err} /></View>;
  const { shift, meta } = data;
  const reasons = meta.techReasons ?? [];
  const book = shift.milk.book;
  const lossSum = reasons.reduce((a, x) => a + toNumber(loss[x.id] || 0), 0);
  const sepOuts = shift.separation?.outputs ?? [];
  const sepGiven = sepOuts.some((o) => (sep[o.product_id] ?? '') !== '');
  const unexplained = left === '' ? null : r3(book - toNumber(left) - lossSum);
  const openTasks = shift.tasks.filter((t) => t.status === 'open' || t.status === 'approval');
  const usedSoFar = shift.milk.used + (sepGiven && unexplained > 0 ? unexplained : 0);
  const submit = async () => {
    setBusy(true);
    try {
      const res = await prod('POST', `/shifts/${shift.id}/close`, {
        milkLeft: toNumber(left),
        losses: reasons.map((x) => ({ reasonId: x.id, qty: toNumber(loss[x.id] || 0) })).filter((l) => l.qty > 0),
        ...(sepGiven ? { separation: { outputs: sepOuts.map((o) => ({ productId: o.product_id, qty: sep[o.product_id] === '' || sep[o.product_id] == null ? 0 : toNumber(sep[o.product_id]) })) } } : {}),
      });
      onDone(res.needApproval ? 'Limitdan oshgan — smena rahbar tasdig\'iga yuborildi' : `${shift.label} yopildi`);
    } catch (e) { notify('Xatolik', e.message); } finally { setBusy(false); }
  };
  return (
    <View style={{ flex: 1 }}>
      <Header title={`${shift.label} — yopish`} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        {openTasks.length > 0 && <Text style={s.err}>Avval ochiq topshiriqlarni yakunlang: {openTasks.map((t) => t.label).join(', ')}</Text>}
        <View style={[s.card, { gap: 6 }]}>
          <Text style={s.text}>"{shift.milk.warehouse}"da hisob bo'yicha: <Text style={{ fontWeight: '700' }}>{fmtQty(book)} kg</Text></Text>
          <Text style={s.muted}>Topshiriqlarda ishlatildi {fmtQty(shift.milk.used)} kg.</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={[s.text, { flex: 1 }]}>Qolgan sut (o'lchab)</Text>
            <Num value={left} onChange={setLeft} unit="kg" />
          </View>
        </View>
        {sepOuts.length > 0 && (
          <View style={[s.card, { gap: 8, borderColor: C.accent }]}>
            <Text style={[s.text, { fontWeight: '700' }]}>Separatsiya (bo'lgan bo'lsa)</Text>
            {sepOuts.map((o) => (
              <View key={o.product_id} style={{ gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={[s.text, { flex: 1 }]}>{o.product} — {o.mode === 'rest' ? 'qoldi' : 'chiqdi'}</Text>
                  <Num value={sep[o.product_id] ?? ''} onChange={(x) => setSep((m) => ({ ...m, [o.product_id]: x }))} unit={o.unit} />
                </View>
                {o.mode === 'rest' && o.book < -0.0005 && <Text style={{ fontSize: 13, color: C.muted }}>Smenada {fmtQty(-o.book)} {o.unit} ishlatildi — chiqqani: qolgani + {fmtQty(-o.book)}</Text>}
              </View>
            ))}
            {sepGiven && unexplained != null && <Text style={{ color: unexplained > 0 ? C.ok : C.err }}>Separatsiyaga ketgan sut: {fmtQty(Math.max(0, unexplained))} kg</Text>}
          </View>
        )}
        <View style={[s.card, { gap: 8 }]}>
          <Text style={s.muted}>Yo'qotish sababi (bir nechta bo'lishi mumkin)</Text>
          {reasons.map((x) => {
            const allowed = x.limit_qty != null && x.limit_base > 0 ? (x.limit_qty * usedSoFar) / x.limit_base : null;
            const v = toNumber(loss[x.id] || 0);
            return (
              <View key={x.id} style={{ gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={[s.text, { flex: 1 }]}>{x.name}</Text>
                  <Num value={loss[x.id] ?? ''} onChange={(y) => setLoss((l) => ({ ...l, [x.id]: y }))} unit="kg" />
                </View>
                {allowed != null && <Text style={{ fontSize: 13, color: v > allowed + 0.0005 ? C.err : C.muted }}>Limit: {fmtQty(r3(allowed))} kg gacha{v > allowed + 0.0005 ? ' — oshib ketdi, rahbar tasdiqlaydi' : ''}</Text>}
              </View>
            );
          })}
        </View>
        {unexplained != null && !sepGiven && (
          <Text style={{ fontSize: 18, fontWeight: '700', color: unexplained > 0.0005 ? C.err : C.ok }}>
            {unexplained > 0.0005 ? `Hisobsiz qoldi: ${fmtQty(unexplained)} kg — separatsiya yoki yo'qotish kiriting` : unexplained < -0.0005 ? `Yutish: +${fmtQty(-unexplained)} kg (hisobdagidan ko'p)` : 'Hammasi hisoblandi'}
          </Text>
        )}
        <Btn title={busy ? '...' : 'Smenani yopish'} onPress={submit} disabled={busy || left === '' || openTasks.length > 0 || (!sepGiven && unexplained > 0.0005)} />
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------- reprocessing
// Expired product taken apart: the container (fixed count per unit) and the content
// (by netto weight, editable within its range). Containers that did not come out
// must be explained: the missing count is filled in, the worker picks the reasons.
function ReprocessTask({ t, r, onBack, onDone, reload }) {
  const { data: reasons } = useLoad(() => api.erp('GET', '/reasons?section=reprocess'), []);
  const units = t.plan.reduce((a, l) => a + l.qty, 0);
  const netto = r.lines[0]?.netto_g;
  const outs = r.outputs.map((o) => {
    const per = o.per_unit ?? (netto ? netto / 1000 : 1);
    return { ...o, expected: Math.round(per * units * 1000) / 1000,
      min: o.min_per_unit != null ? Math.round(o.min_per_unit * units * 1000) / 1000 : null,
      max: o.max_per_unit != null ? Math.round(o.max_per_unit * units * 1000) / 1000 : null };
  });
  const [vals, setVals] = useState({});
  const [short, setShort] = useState({});
  const [busy, setBusy] = useState(false);
  const val = (o) => (vals[o.product_id] ?? String(o.expected));
  const box = outs.find((o) => o.is_container);
  const missing = box ? Math.max(0, Math.round((box.expected - toNumber(val(box) || 0)) * 1000) / 1000) : 0;
  const active = (reasons ?? []).filter((x) => x.active);
  // The missing count goes to the first reason until the worker splits it.
  const shortOf = (id, i) => (short[id] ?? (i === 0 && !Object.keys(short).length ? String(missing) : ''));
  const told = active.reduce((a, x, i) => a + toNumber(shortOf(x.id, i) || 0), 0);
  const editable = t.status === 'open';

  const finish = async () => {
    setBusy(true);
    try {
      const res = await prod('POST', `/tasks/${t.id}/complete`, {
        outputs: outs.map((o) => ({ productId: o.product_id, qty: toNumber(val(o) || 0) })),
        shortfall: missing > 0 ? active.map((x, i) => ({ reasonId: x.id, qty: toNumber(shortOf(x.id, i) || 0) })).filter((x) => x.qty > 0) : [],
      });
      onDone(res.needApproval ? `${t.label}: miqdor chegaradan tashqarida — rahbar tasdig'iga yuborildi` : `${t.label} bajarildi`);
    } catch (e) { notify('Xatolik', e.message); reload(); } finally { setBusy(false); }
  };
  return (
    <View style={{ flex: 1 }}>
      <Header title={`${t.label} · ${t.recipe}`} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Badge map={TASK} status={t.status} />
        <View style={[s.card, { gap: 4 }]}>
          <Text style={s.text}>{t.plan[0]?.product}: <Text style={{ fontWeight: '700' }}>{fmtQty(units)} {t.plan[0]?.unit}</Text></Text>
          <Text style={s.muted}>Shundan chiqdi:</Text>
          {outs.map((o) => {
            const v = toNumber(val(o) || 0);
            const bad = !o.is_container && ((o.min != null && v < o.min - 0.0005) || (o.max != null && v > o.max + 0.0005));
            return (
              <View key={o.product_id} style={{ gap: 2, paddingVertical: 4 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={[s.text, { flex: 1 }]}>{o.product}</Text>
                  {editable ? <Num value={val(o)} unit={o.unit} onChange={(x) => setVals((m) => ({ ...m, [o.product_id]: x }))} />
                    : <Text style={[s.text, { fontWeight: '700' }]}>{fmtQty((t.outputs.find((x) => x.product_id === o.product_id)?.qty) ?? 0)} {o.unit}</Text>}
                </View>
                {editable && <Text style={{ fontSize: 13, color: bad ? C.err : C.muted }}>
                  {o.is_container ? `Chiqishi kerak: ${fmtQty(o.expected)}` : `Hisob: ${fmtQty(o.expected)}${o.min != null || o.max != null ? ` · ruxsat ${fmtQty(o.min ?? 0)}–${o.max == null ? '∞' : fmtQty(o.max)}` : ''}`}
                  {bad ? ' — chegaradan tashqarida, rahbar tasdiqlaydi' : ''}</Text>}
              </View>
            );
          })}
        </View>
        {editable && missing > 0 && (
          <View style={[s.card, { gap: 8, borderColor: C.warn }]}>
            <Text style={[s.text, { fontWeight: '700' }]}>{fmtQty(box.expected)} ta chiqishi kerak edi, {fmtQty(toNumber(val(box) || 0))} ta kiritdingiz — qolgan {fmtQty(missing)} tasi nima bo'ldi?</Text>
            {active.map((x, i) => (
              <View key={x.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={[s.text, { flex: 1 }]}>{x.name}</Text>
                <Num value={shortOf(x.id, i)} unit="dona" onChange={(v) => setShort((m) => ({ ...Object.fromEntries(active.map((y, j) => [y.id, shortOf(y.id, j)])), ...m, [x.id]: v }))} />
              </View>
            ))}
            {Math.abs(told - missing) > 0.0005 && <Text style={s.err}>Jami {fmtQty(missing)} ta bo'lishi kerak (hozir {fmtQty(told)})</Text>}
          </View>
        )}
        {editable && <Btn title={busy ? '...' : 'Yakunlash'} onPress={finish} disabled={busy || (missing > 0 && Math.abs(told - missing) > 0.0005)} />}
        {t.status === 'approval' && <Text style={{ color: C.warn }}>Rahbar tasdig'ini kuting.</Text>}
      </ScrollView>
    </View>
  );
}
