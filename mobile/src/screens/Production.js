import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import * as api from '../api';
import { ask, notify } from '../dialog';
import { Btn, Chip, Err, Header, fmtDT, kioskField, textMatch, toNumber, useLoad } from '../components';
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
  // today's plan for a product (pourer)
  const planOf = (w) => (data?.plan?.pour ?? []).find((x) => x.product_id === w.product_id);
  const stages = data?.stages ?? [];
  const sh = data?.shift;
  const produce = stages.find((x) => x.code === 'produce');
  const sm = sh?.summary;
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
              <Text style={s.muted}>Qabul qilingan (tanlangan smenalar): {fmtQty(sm?.received ?? 0)} kg · ochildi {fmtDT(sh.opened_at)}</Text>
              {sh.status === 'approval' && <Text style={{ color: C.warn }}>Smena yakuni rahbar tasdig'ini kutmoqda</Text>}
              {!!sh.approval_note && <Text style={{ color: C.err }}>Rahbar: {sh.approval_note}</Text>}
            </>
          ) : <Text style={s.muted}>Birinchi topshiriq boshlanganda smena o'zi ochiladi.</Text>}
          {/* Separation: entered at the end of the shift; skim milk / cream used so far is shown */}
          <View style={{ borderTopWidth: 1, borderColor: C.line, paddingTop: 8, gap: 4 }}>
            <Text style={[s.text, { fontWeight: '700' }]}>Separatsiya</Text>
            {sm?.separated ? <Text style={{ color: C.ok }}>Kiritildi: toza qaymoq {fmtQty(sm.cream)} kg, yog'siz sut {fmtQty(sm.skim_used)} kg</Text>
              : sm?.skim_used > 0 ? <Text style={{ color: C.warn }}>Yog'siz sut: {fmtQty(sm.skim_used)} kg sarflandi — smena oxirida separatsiya kiritasiz</Text>
              : <Text style={s.muted}>Toza qaymoq smena oxirida kiritiladi; yog'siz sut sarfga qarab o'zi hisoblanadi.</Text>}
          </View>
          {sh?.status === 'open' && <Btn title="Separatsiya va smenani yopish" kind="ghost" onPress={onClose} />}
        </View>
      )}
      {produce && !!data?.plan?.tech?.length && (
        <View style={[s.card, { gap: 8 }]}>
          <Text style={s.h2}>Bugungi rejalar</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {data.plan.tech.map((t) => {
              const left = Math.max(0, r3(t.qty - t.made));
              return (
                <Pressable key={t.recipe_id} onPress={() => onNew({ stageId: produce.id, recipeId: t.recipe_id, planKg: left || t.qty })}
                  style={({ pressed }) => [s.card, { minWidth: 150, flexGrow: 1, flexDirection: 'row', gap: 10, alignItems: 'center', padding: 12, borderColor: left > 0 ? C.accent : C.line }, pressed && { opacity: 0.6 }]}>
                  <View style={{ backgroundColor: left > 0 ? C.accent : C.line, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 6, minWidth: 64, alignItems: 'center' }}>
                    <Text style={{ color: left > 0 ? C.accentText : C.text, fontWeight: '700' }}>{fmtQty(t.qty)} {t.unit}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.text, { fontWeight: '700' }]}>{t.quyma}</Text>
                    <Text style={s.muted}>{t.made ? `chiqdi ${fmtQty(t.made)} · ` : ''}{t.products.map((x) => `${x.product} ${fmtQty(x.plan)}`).join(', ')}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}
      {(data?.tasks ?? []).map((t) => (
        <Pressable key={t.id} onPress={() => onTask(t.id)} style={({ pressed }) => [s.card, { gap: 4, borderColor: C.warn }, pressed && { opacity: 0.6 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <Text style={[s.text, { fontWeight: '700', flex: 1 }]}>{t.label} · {t.product ?? t.recipe ?? t.stage}</Text>
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
          {st.type === 'change' && st.code === 'produce' ? (
            st.waiting.map((w) => (
              <Pressable key={w.recipe_id} onPress={() => onNew({ stageId: st.id, recipeId: w.recipe_id })}
                style={({ pressed }) => [{ paddingVertical: 10, borderTopWidth: 1, borderColor: C.line, gap: 2 }, pressed && { opacity: 0.6 }]}>
                <Text style={[s.text, { fontWeight: '600' }]}>{w.recipe}{w.product && w.product !== w.recipe ? ` → ${w.product}` : ''}</Text>
              </Pressable>
            )).concat(st.waiting.length ? [] : [<Text key="none" style={s.muted}>Bu bosqichda tarkib yo'q</Text>])
          ) : st.type === 'change' ? (
            // Grouped by what waits (e.g. one quyma for several products): the worker chooses what to make.
            Object.values(st.waiting.reduce((g, w) => {
              const k = w.waiting ? `${w.waiting.product_id}:${w.waiting.from}` : `x${w.product_id}`;
              (g[k] ??= { head: w.waiting, items: [] }).items.push(w);
              return g;
            }, {})).map((grp, gi) => (
              <View key={gi} style={{ borderTopWidth: 1, borderColor: C.line, paddingTop: 8, gap: 6 }}>
                {grp.head ? <Text style={{ color: grp.head.qty > 0 ? C.ok : C.muted, fontWeight: '600' }}>{grp.head.product}: {fmtQty(grp.head.qty)} {grp.head.unit} — {grp.head.from_name}da</Text> : null}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {grp.items.slice().sort((x, y) => (planOf(y)?.plan ?? 0) - (planOf(x)?.plan ?? 0)).map((w) => {
                    const pl = planOf(w);
                    const left = pl ? Math.max(0, r3(pl.plan - pl.made)) : null;
                    return (
                      <Pressable key={w.product_id} onPress={() => onNew({ stageId: st.id, recipeId: w.recipe_id, productId: w.product_id, productName: w.product, planUnits: left || null, avail: grp.head?.qty ?? null })}
                        style={({ pressed }) => [{ borderWidth: 1, borderColor: pl ? C.accent : C.line, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', gap: 6, alignItems: 'center' }, pressed && { opacity: 0.6 }]}>
                        <Text style={s.text}>{w.product}</Text>
                        {pl && <View style={{ backgroundColor: C.accent, borderRadius: 99, paddingHorizontal: 6 }}><Text style={{ color: C.accentText, fontSize: 12, fontWeight: '700' }}>{fmtQty(left)}</Text></View>}
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )).concat(st.waiting.length ? [] : [<Text key="none" style={s.muted}>Tex kartalarda bu bosqich uchun mahsulot yo'q</Text>])
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
export function NewTask({ stageId, recipeId, productId, productName, planKg, planUnits, avail, onBack, onDone }) {
  const { data, err } = useLoad(() => Promise.all([prod('GET', `/recipes/${recipeId}`), api.erp('GET', '/products?stock=1')]), [recipeId]);
  const [r, products] = data ?? [null, []];
  const [units, setUnits] = useState('');
  const [over, setOver] = useState({});
  const [extra, setExtra] = useState([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const perUnit = r && PER_UNIT.has(r.kind);
  // Main raw materials (milk, skim milk) lead; the rest follow their total.
  const mains = r ? r.lines.filter((l) => l.product_kind === 'main_raw') : [];
  const expected = r ? (r.out_min != null && r.out_max != null ? (r.out_min + r.out_max) / 2 : r.base_weight) : 0;
  const mainSuggest = (l) => (planKg && r.base_milk > 0 && expected > 0 ? r3((planKg * r.base_milk / expected) * (l.qty / r.base_milk)) : null);
  const mainVal = (l) => (over[l.id]?.qty ?? '') !== '' ? toNumber(over[l.id].qty) : (mainSuggest(l) ?? 0);
  const mainTotal = mains.reduce((a, l) => a + mainVal(l), 0);
  const f = !r ? 0 : perUnit ? toNumber(units || (planUnits ?? 0)) : r.base_milk > 0 ? mainTotal / r.base_milk : toNumber(units || 1);
  const lines = r ? r.lines.map((l) => {
    const o = over[l.id] ?? {};
    const pid = o.productId ?? l.product_id;
    const alt = l.alts.find((a) => a.product_id === pid || a.variants.some((v) => v.id === pid));
    const base = alt ?? l;
    const variant = base.variants?.find((v) => v.id === pid);
    const main = l.product_kind === 'main_raw';
    // pouring: the quyma starts as everything the stage before holds
    const semiDefault = perUnit && avail != null && products.find((x) => x.id === pid)?.kind === 'semi' ? String(avail) : null;
    const suggest = main ? mainSuggest(l) : r3((alt?.qty ?? l.qty) * f);
    return { l, base, pid, main, name: variant?.name ?? base.product, unit: base.unit, variants: base.variants ?? [],
      typed: o.qty ?? semiDefault ?? '', suggest };
  }) : [];
  const found = search.trim().length >= 2 ? products.filter((x) => textMatch(x.name, search) && !lines.some((l) => l.pid === x.id) && !extra.some((e) => e.productId === x.id)).slice(0, 8) : [];
  const start = async () => {
    setBusy(true);
    try {
      const t = await prod('POST', '/tasks', {
        uuid: randomUUID(), stageId, recipeId: r.id, ...(productId ? { productId } : {}),
        ...(perUnit ? { units: f } : r.base_milk > 0 ? { milkQty: r3(mainTotal) } : { factor: f }),
        lines: lines.map((x) => ({ lineId: x.l.id, productId: x.pid, ...(x.typed !== '' ? { qty: toNumber(x.typed) } : x.main ? { qty: x.suggest ?? 0 } : {}) })),
        extra: extra.filter((e) => toNumber(e.qty || 0) > 0).map((e) => ({ productId: e.productId, qty: toNumber(e.qty) })),
      }, { idempotent: true });
      onDone(t.id);
    } catch (e) { notify('Xatolik', e.message); } finally { setBusy(false); }
  };
  return (
    <View style={{ flex: 1 }}>
      <Header title={productName ?? (r ? r.name : 'Topshiriq')} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Err err={err} />
        {r && (
          <View style={[s.card, { gap: 8 }]}>
            {!!planKg && <Text style={{ color: C.accent, fontWeight: '600' }}>Reja: {fmtQty(planKg)} kg {r.product}</Text>}
            {perUnit && (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={s.text}>Nechta dona?{planUnits ? ` (reja: ${fmtQty(planUnits)})` : ''}</Text>
                <Num value={units} onChange={setUnits} unit="dona" placeholder={planUnits ? String(planUnits) : '0'} />
              </View>
            )}
            {!perUnit && !(r.base_milk > 0) && (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={s.text}>Necha partiya?</Text>
                <Num value={units} onChange={setUnits} unit="×" placeholder="1" />
              </View>
            )}
            <Text style={s.muted}>Tarkib — xira raqamlar tavsiya, bosib o'zgartirasiz:</Text>
            {lines.map((x) => (
              <View key={x.l.id} style={{ gap: 6, paddingVertical: 6, borderBottomWidth: 1, borderColor: C.line }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <Text style={[s.text, { flex: 1 }, x.main && { fontWeight: '700' }]}>{x.name}{x.main ? '  · asosiy' : ''}</Text>
                  <Num value={x.typed} placeholder={x.suggest != null ? String(x.suggest) : '0'} unit={x.unit}
                    onChange={(v) => setOver((o) => ({ ...o, [x.l.id]: { ...(o[x.l.id] ?? {}), qty: v } }))} />
                </View>
                {x.l.alts.length > 0 && (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {[{ product_id: x.l.product_id, product: x.l.product }, ...x.l.alts].map((a) => (
                      <Chip key={a.product_id} label={a.product} on={a.product_id === x.base.product_id}
                        onPress={() => setOver((o) => ({ ...o, [x.l.id]: { ...(o[x.l.id] ?? {}), productId: a.product_id } }))} />
                    ))}
                  </View>
                )}
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
            {extra.map((e, i) => (
              <View key={e.productId} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderColor: C.line }}>
                <Text style={[s.text, { flex: 1 }]}>{e.name}</Text>
                <Num value={e.qty} unit={e.unit} onChange={(v) => setExtra((xs) => xs.map((y, j) => (j === i ? { ...y, qty: v } : y)))} />
                <Pressable onPress={() => setExtra((xs) => xs.filter((_, j) => j !== i))}><Text style={{ color: C.err, fontSize: 18 }}>✕</Text></Pressable>
              </View>
            ))}
            {!perUnit && (
              <View style={{ gap: 6 }}>
                <TextInput style={[s.input, { paddingVertical: 8 }]} value={search} onChangeText={setSearch} placeholder="+ Boshqa xomashyo qidirish" placeholderTextColor={C.placeholder} />
                {found.length > 0 && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {found.map((p) => <Chip key={p.id} label={p.name} on={false} onPress={() => { setExtra((xs) => [...xs, { productId: p.id, name: p.name, unit: p.unit, qty: '' }]); setSearch(''); }} />)}
                </View>}
              </View>
            )}
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
  // The output: the product chosen for this task (its Tex karta gave the recipe), else the recipe's own.
  const outId = t.product_id ?? r?.product_id;
  const outs = r?.kind === 'separation' ? r.outputs.map((o) => ({ productId: o.product_id, name: o.product, unit: o.unit })) : [{ productId: outId, name: t.product ?? r?.product, unit: t.product_unit ?? r?.unit }];
  const outWeight = perUnit ? toNumber(out[outId] ?? String(t.factor)) : outs.reduce((a, o) => a + weightKg(o.unit, toNumber(out[o.productId] || 0)), 0);
  // "Who did it with you" only where a piece wage is paid (never in production).
  const paid = (r?.rates?.length ?? 0) > 0;
  const outside = range && outWeight > 0 && ((range.min != null && outWeight < range.min - 0.0005) || (range.max != null && outWeight > range.max + 0.0005));
  const editable = t.status === 'open';

  const finish = async () => {
    setBusy(true);
    try {
      const body = { lines: inputs.map((l) => ({ productId: l.productId, qty: toNumber(l.qty) })), ...(paid ? { workers: team } : {}) };
      if (r.kind !== 'separation') body.outputQty = toNumber(out[outId] ?? (perUnit ? String(t.factor) : 0));
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
      <Header title={`${t.label} · ${t.product ?? t.recipe}`} onBack={onBack} />
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
        {editable && paid && <Workers staff={meta?.staff} team={team} setTeam={setWorkers} />}
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
// "Qabul qilingan sut" is never typed: it comes from the accepted collector shifts the
// technologist ticks (⬇). Separation is its own step: the skim milk made is what the
// shift used; only the cream is entered (separation never loses anything). The loss
// = received − (milk used + skim milk + cream) must be explained in full.
function MilkShiftPicker({ shift, onBack, onSaved }) {
  const { data, err } = useLoad(() => prod('GET', '/milk-shifts'), []);
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(false);
  const chosen = sel ?? new Set((data ?? []).filter((x) => x.selected).map((x) => x.id));
  const total = (data ?? []).filter((x) => chosen.has(x.id)).reduce((a, x) => a + x.qty, 0);
  const toggle = (x) => { if (x.used) return; const n = new Set(chosen); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); setSel(n); };
  const save = async () => {
    setBusy(true);
    try { await prod('PUT', `/shifts/${shift.id}/milk`, { shiftIds: [...chosen] }); onSaved(); } catch (e) { notify('Xatolik', e.message); } finally { setBusy(false); }
  };
  return (
    <View style={{ flex: 1 }}>
      <Header title="Qabul qilingan sut" onBack={onBack} />
      <View style={[s.card, { margin: 12, marginBottom: 0, alignItems: 'center' }]}>
        <Text style={s.muted}>Tanlangan smenalar: {chosen.size} ta</Text>
        <Text style={{ fontSize: 30, fontWeight: '700', color: C.text }}>{fmtQty(r3(total))} kg</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
        <Err err={err} />
        {(data ?? []).map((x) => (
          <Pressable key={x.id} onPress={() => toggle(x)} style={({ pressed }) => [s.card, { flexDirection: 'row', alignItems: 'center', gap: 12, opacity: x.used ? 0.45 : 1 }, pressed && !x.used && { opacity: 0.6 }]}>
            <View style={{ width: 26, height: 26, borderRadius: 6, borderWidth: 2, borderColor: C.accent, backgroundColor: chosen.has(x.id) ? C.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
              {chosen.has(x.id) && <Text style={{ color: C.accentText, fontWeight: '700' }}>✓</Text>}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.text, { fontWeight: '700' }]}>Smena {x.label} · {x.collector}</Text>
              <Text style={s.muted}>{fmtDT(x.accepted_at)}{x.used ? ' · boshqa smenada hisoblangan' : ''}</Text>
            </View>
            <Text style={[s.text, { fontWeight: '700' }]}>{fmtQty(x.qty)} kg</Text>
          </Pressable>
        ))}
        {data && !data.length && <Text style={s.muted}>Qabul qilingan smena yo'q</Text>}
      </ScrollView>
      <View style={{ padding: 12 }}><Btn title={busy ? '...' : 'Saqlash'} onPress={save} disabled={busy} /></View>
    </View>
  );
}

export function CloseShift({ onBack, onDone }) {
  const { data, err, load } = useLoad(async () => {
    const [{ shift }, meta] = await Promise.all([prod('GET', '/shift'), api.erp('GET', '/meta')]);
    return { shift, meta };
  }, []);
  const [picking, setPicking] = useState(false);
  const [sepVals, setSepVals] = useState({});
  const [loss, setLoss] = useState({});
  const [busy, setBusy] = useState(false);
  if (!data?.shift) return <View style={{ flex: 1 }}><Header title="Smenani yopish" onBack={onBack} /><Err err={err} /></View>;
  const { shift, meta } = data;
  if (picking) return <MilkShiftPicker shift={shift} onBack={() => setPicking(false)} onSaved={() => { setPicking(false); load(); }} />;
  const sm = shift.summary;
  const reasons = meta.techReasons ?? [];
  const lossSum = r3(reasons.reduce((a, x) => a + toNumber(loss[x.id] || 0), 0));
  const lossQty = Math.max(0, sm.loss_qty);
  const openTasks = shift.tasks.filter((t) => t.status === 'open' || t.status === 'approval');
  const sepRecipe = sm.separation_recipe;
  const separate = async () => {
    setBusy(true);
    try {
      await prod('POST', `/shifts/${shift.id}/separation`, { outputs: (sepRecipe?.outputs ?? []).filter((o) => o.mode !== 'rest').map((o) => ({ productId: o.product_id, qty: toNumber(sepVals[o.product_id] || 0) })) });
      await load();
    } catch (e) { notify('Xatolik', e.message); } finally { setBusy(false); }
  };
  const submit = async () => {
    setBusy(true);
    try {
      const res = await prod('POST', `/shifts/${shift.id}/close`, { losses: reasons.map((x) => ({ reasonId: x.id, qty: toNumber(loss[x.id] || 0) })).filter((l) => l.qty > 0) });
      onDone(res.needApproval ? 'Limitdan oshgan — smena rahbar tasdig\'iga yuborildi' : `${shift.label} yopildi — haqiqiy tannarx hisoblandi`);
    } catch (e) { notify('Xatolik', e.message); } finally { setBusy(false); }
  };
  const Row = ({ label, value, bold, sub, color }) => (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, paddingLeft: sub ? 16 : 0 }}>
      <Text style={[sub ? s.muted : s.text, bold && { fontWeight: '700' }]}>{label}</Text>
      <Text style={[s.text, { fontWeight: bold ? '700' : '600' }, color && { color }]}>{value}</Text>
    </View>
  );
  const canClose = !openTasks.length && !sm.need_separation && (sm.total <= 0.0005 || sm.milk_shifts.length) && sm.loss_qty >= -0.0005 && Math.abs(lossSum - lossQty) <= 0.0005;
  return (
    <View style={{ flex: 1 }}>
      <Header title={`${shift.label} — yopish`} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        {openTasks.length > 0 && <Text style={s.err}>Avval ochiq topshiriqlarni yakunlang: {openTasks.map((t) => t.label).join(', ')}</Text>}
        {/* separation first: the skim milk made is what the shift used */}
        {sepRecipe && !sm.separated && (
          <View style={[s.card, { gap: 8, borderColor: C.accent }]}>
            <Text style={[s.text, { fontWeight: '700' }]}>Separatsiya</Text>
            {sepRecipe.outputs.map((o) => (o.mode === 'rest' ? (
              <Row key={o.product_id} label={`${o.product} (smenada sarflangan)`} value={`${fmtQty(o.qty ?? 0)} ${o.unit}`} />
            ) : (
              <View key={o.product_id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={[s.text, { flex: 1 }]}>{o.product} — chiqdi</Text>
                <Num value={sepVals[o.product_id] ?? ''} onChange={(x) => setSepVals((m) => ({ ...m, [o.product_id]: x }))} unit={o.unit} />
              </View>
            )))}
            <Text style={s.muted}>Separatsiyada yo'qotish bo'lmaydi: sut = yog'siz sut + toza qaymoq.</Text>
            <Btn title={busy ? '...' : 'Separatsiya'} onPress={separate} disabled={busy} />
          </View>
        )}
        <View style={[s.card, { gap: 2 }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 }}>
            <Text style={[s.text, { fontWeight: '700' }]}>Qabul qilingan sut: {fmtQty(sm.received)} kg</Text>
            <Pressable onPress={() => setPicking(true)} style={[s.card, { paddingVertical: 6, paddingHorizontal: 12 }]}><Text style={{ fontSize: 20 }}>⬇</Text></Pressable>
          </View>
          <Row label="Sarflandi" value={`${fmtQty(r3(sm.milk_direct + sm.skim_used))} kg`} bold />
          <Row label="Yog'li sut" value={`${fmtQty(sm.milk_direct)} kg`} sub />
          <Row label="Yog'siz sut" value={`${fmtQty(sm.skim_used)} kg`} sub />
          <Row label="Toza qaymoq" value={sm.cream == null ? 'separatsiya kiritilmagan' : `${fmtQty(sm.cream)} kg`} />
          <Row label="Jami" value={`${fmtQty(sm.total)} kg`} bold />
          <Row label="Yo'qotish" value={`${fmtQty(sm.loss_qty)} kg`} bold color={sm.loss_qty < -0.0005 ? C.err : C.warn} />
          {sm.loss_qty < -0.0005 && <Text style={s.err}>Qabul qilingan sut sarflangandan kam — yana smena tanlang (⬇)</Text>}
        </View>
        {lossQty > 0.0005 && (
          <View style={[s.card, { gap: 8 }]}>
            <Text style={s.muted}>Yo'qotish miqdori va sababini kiriting ({fmtQty(lossQty)} kg)</Text>
            {reasons.map((x) => {
              const allowed = x.limit_qty != null && x.limit_base > 0 ? (x.limit_qty * sm.total) / x.limit_base : null;
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
            <Text style={{ fontWeight: '700', color: Math.abs(lossSum - lossQty) <= 0.0005 ? C.ok : C.err }}>Kiritildi: {fmtQty(lossSum)} / {fmtQty(lossQty)} kg</Text>
          </View>
        )}
        <Btn title={busy ? '...' : 'Smenani yopish'} onPress={submit} disabled={busy || !canClose} />
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
