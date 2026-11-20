import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import * as api from '../api';
import { ask, notify } from '../dialog';
import { Btn, Chip, Err, Header, fmtDT, toNumber, useLoad } from '../components';
import { C, fmtQty, s } from '../ui';

// Technologist's workplace (Yaya 2.0, stage 2): open a shift, run tasks from
// recipes (milk and materials come from what was handed to them), weigh the
// output, and at the end explain the milk that is not accounted for.
// No sums anywhere — the server does not send them to the technologist.

const prod = (method, path, body, opts) => api.erp(method, `/prod${path}`, body, opts);
export const canProduce = () => api.canAny('prod.work', 'prod.pour', 'prod.cap');
const PER_UNIT = new Set(['pour', 'cap']);

const TASK = { open: ['Jarayonda', C.warn], approval: ['Rahbar tasdig\'ini kutmoqda', C.warn], done: ['Bajarildi', C.ok], cancelled: ['Bekor qilingan', C.err] };
function Badge({ map, status }) {
  const [t, color] = map[status] ?? [status, C.muted];
  return <View style={{ borderWidth: 1, borderColor: color, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' }}><Text style={{ color, fontSize: 13, fontWeight: '600' }}>{t}</Text></View>;
}
const weightKg = (unit, qty) => { const u = String(unit || 'kg').toLowerCase(); return u === 'g' || u === 'gramm' ? qty / 1000 : u === 'dona' ? 0 : qty; };

function Num({ value, onChange, unit, width = 120, placeholder = '0' }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <TextInput style={[s.input, { width, paddingVertical: 8, fontSize: 18, textAlign: 'right' }]} keyboardType="decimal-pad" value={String(value ?? '')}
        onChangeText={onChange} placeholder={placeholder} placeholderTextColor={C.placeholder} />
      {!!unit && <Text style={[s.muted, { minWidth: 30 }]}>{unit}</Text>}
    </View>
  );
}

// ---------------------------------------------------------------- main
export function Production({ tick, onTask, onNew, onClose }) {
  const { data, err, busy, load } = useLoad(() => prod('GET', '/shift'), [tick]);
  const sh = data?.shift;
  const open = async () => {
    try { await prod('POST', '/shift', { uuid: randomUUID() }, { idempotent: true }); load(); } catch (e) { notify('Xatolik', e.message); }
  };
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}>
      <Err err={err} />
      {data && !sh && (
        <View style={[s.card, { gap: 12 }]}>
          <Text style={s.h2}>Smena ochilmagan</Text>
          <Text style={s.muted}>Kerakli mahsulotni (sut, quyma, idish, etiketka, qopqoq...) "Ombor" bo'limida qabul qiling, keyin smenani oching.</Text>
          <Btn title="Smena ochish" onPress={open} />
        </View>
      )}
      {sh && (
        <>
          <View style={[s.card, { gap: 6 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={s.h2}>{sh.label}</Text>
              {sh.status === 'approval' && <Badge map={{ approval: ['Rahbar tasdig\'ini kutmoqda', C.warn] }} status="approval" />}
            </View>
            <Text style={s.muted}>Ochildi {fmtDT(sh.opened_at)}</Text>
            {(sh.milk.in_hands !== 0 || sh.milk.used > 0) && (
              <>
                <Text style={s.text}>Qo'lingizda {sh.milk.product}: <Text style={{ fontWeight: '700' }}>{fmtQty(sh.milk.in_hands)} kg</Text></Text>
                <Text style={s.text}>Topshiriqlarda ishlatildi: <Text style={{ fontWeight: '700' }}>{fmtQty(sh.milk.used)} kg</Text></Text>
              </>
            )}
            {!!sh.approval_note && <Text style={{ color: C.err }}>Rahbar: {sh.approval_note}</Text>}
          </View>
          {sh.status === 'open' && <Btn title="+ Yangi topshiriq" onPress={onNew} />}
          {sh.tasks.slice().reverse().map((t) => (
            <Pressable key={t.id} onPress={() => onTask(t.id)} style={({ pressed }) => [s.card, { gap: 4 }, pressed && { opacity: 0.6 }]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <Text style={[s.text, { fontWeight: '700', flex: 1 }]}>{t.label} · {t.recipe}</Text>
                <Badge map={TASK} status={t.status} />
              </View>
              {t.outputs.map((o) => <Text key={o.product_id} style={s.text}>{o.product}: <Text style={{ fontWeight: '700' }}>{fmtQty(o.qty)} {o.unit}</Text></Text>)}
              {t.status === 'open' && <Text style={s.muted}>{t.plan.map((l) => `${l.product} ${fmtQty(l.qty)} ${l.unit}`).join(' · ')}</Text>}
              {!!t.approval_note && t.status === 'open' && <Text style={{ color: C.err }}>Rad etildi: {t.approval_note}</Text>}
            </Pressable>
          ))}
          {sh.status === 'open' && <Btn title="Smenani yopish" kind="ghost" onPress={onClose} />}
        </>
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------- new task
export function NewTask({ onBack, onDone }) {
  const { data: recipes, err } = useLoad(() => prod('GET', '/recipes?mine=1'), []);
  const [rid, setRid] = useState(null);
  const [milk, setMilk] = useState('');
  const [factor, setFactor] = useState('');
  const [over, setOver] = useState({});
  const [busy, setBusy] = useState(false);
  const r = recipes?.find((x) => x.id === rid);
  const perUnit = r && PER_UNIT.has(r.kind);
  const f = r ? (r.base_milk > 0 && !perUnit ? toNumber(milk || 0) / r.base_milk : toNumber(factor || 0)) : 0;
  const lines = r ? r.lines.map((l) => {
    const o = over[l.id] ?? {};
    const pid = o.productId ?? l.product_id;
    const alt = l.alts.find((a) => a.product_id === pid);
    const name = alt ? alt.product : l.product;
    const unit = alt ? alt.unit : l.unit;
    const auto = Math.round((alt?.qty ?? l.qty) * f * 1000) / 1000;
    return { l, pid, name, unit, qty: o.qty ?? (f > 0 ? String(auto) : ''), auto };
  }) : [];
  const start = async () => {
    setBusy(true);
    try {
      const t = await prod('POST', '/tasks', {
        uuid: randomUUID(), recipeId: r.id, ...(perUnit ? { units: toNumber(factor) } : r.base_milk > 0 ? { milkQty: toNumber(milk) } : { factor: toNumber(factor) }),
        lines: lines.map((x) => ({ lineId: x.l.id, productId: x.pid, ...(x.qty !== String(x.auto) ? { qty: toNumber(x.qty) } : {}) })),
      }, { idempotent: true });
      onDone(t.id);
    } catch (e) { notify('Xatolik', e.message); } finally { setBusy(false); }
  };
  return (
    <View style={{ flex: 1 }}>
      <Header title="Yangi topshiriq" onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Err err={err} />
        <View style={[s.card, { gap: 8 }]}>
          <Text style={s.muted}>Nima tayyorlanadi?</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(recipes ?? []).map((x) => <Chip key={x.id} label={x.name} on={x.id === rid} onPress={() => { setRid(x.id); setOver({}); }} />)}
          </View>
          {recipes && !recipes.length && <Text style={s.muted}>Tarkiblar hali kiritilmagan (panel → Ishlab chiqarish → Tarkiblar).</Text>}
        </View>
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
                      <Chip key={a.product_id} label={a.product} on={a.product_id === x.pid}
                        onPress={() => setOver((o) => ({ ...o, [x.l.id]: { productId: a.product_id } }))} />
                    ))}
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
  const [sendTo, setSendTo] = useState(undefined);
  const [qty, setQty] = useState({});
  const [out, setOut] = useState({});
  const [busy, setBusy] = useState(false);
  const t = data?.t; const r = data?.r; const meta = data?.meta;
  const perUnit = r && PER_UNIT.has(r.kind);
  const team = workers ?? [me?.id];
  // Next step: incubator first for pouring, finished goods for capping.
  const order = r?.kind === 'pour' ? ['incubator', 'finished'] : ['finished', 'incubator'];
  const places = meta ? [...meta.warehouses].sort((a, b) => (order.indexOf(a.kind) + 1 || 9) - (order.indexOf(b.kind) + 1 || 9)) : [];
  const target = sendTo === undefined ? (perUnit && places[0] && order.includes(places[0].kind) ? { warehouseId: places[0].id } : null) : sendTo;
  const inputs = useMemo(() => (t ? t.plan.map((l) => ({ ...l, qty: qty[l.productId] ?? String(l.qty) })) : []), [t, qty]);
  if (!t) return <View style={{ flex: 1 }}><Header title="Topshiriq" onBack={onBack} /><Err err={err} /></View>;
  const inWeight = inputs.reduce((a, l) => a + weightKg(l.unit, toNumber(l.qty || 0)), 0);
  const scale = r?.base_weight > 0 ? inWeight / r.base_weight : 1;
  const range = r && !PER_UNIT.has(r.kind) && (r.out_min != null || r.out_max != null) ? { min: r.out_min == null ? null : r.out_min * scale, max: r.out_max == null ? null : r.out_max * scale } : null;
  const outs = r?.kind === 'separation' ? r.outputs.map((o) => ({ productId: o.product_id, name: o.product, unit: o.unit })) : [{ productId: r?.product_id, name: r?.product, unit: r?.unit }];
  const outWeight = perUnit ? toNumber(out[r.product_id] ?? String(t.factor)) : outs.reduce((a, o) => a + weightKg(o.unit, toNumber(out[o.productId] || 0)), 0);
  const outside = range && outWeight > 0 && ((range.min != null && outWeight < range.min - 0.0005) || (range.max != null && outWeight > range.max + 0.0005));
  const editable = t.status === 'open';

  const finish = async () => {
    setBusy(true);
    try {
      const body = { lines: inputs.map((l) => ({ productId: l.productId, qty: toNumber(l.qty) })) };
      if (r.kind !== 'separation') body.outputQty = toNumber(out[r.product_id] ?? (perUnit ? String(t.factor) : 0));
      else body.outputs = outs.map((o) => ({ productId: o.productId, qty: toNumber(out[o.productId] || 0) }));
      if (r.rates?.length) body.workers = team;
      if (target) body.sendTo = target;
      const res = await prod('POST', `/tasks/${t.id}/complete`, body);
      onDone(res.needApproval ? `${t.label}: chiqish limitdan tashqarida — rahbar tasdig'iga yuborildi` : `${t.label} bajarildi`);
    } catch (e) { notify('Xatolik', e.message); load(); } finally { setBusy(false); }
  };
  const cancel = () => ask('Bekor qilish', `${t.label} bekor qilinsinmi? Ishlatilgan mahsulot qo'lingizga qaytadi.`, 'Ha', async () => {
    try { await prod('POST', `/tasks/${t.id}/cancel`, { reason: 'Texnolog bekor qildi' }); onDone(`${t.label} bekor qilindi`); } catch (e) { notify('Xatolik', e.message); }
  });

  return (
    <View style={{ flex: 1 }}>
      <Header title={`${t.label} · ${t.recipe}`} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Badge map={TASK} status={t.status} />
        {!!t.approval_note && <Text style={{ color: t.status === 'open' ? C.err : C.muted }}>Rahbar: {t.approval_note}</Text>}
        <View style={[s.card, { gap: 4 }]}>
          <Text style={[s.muted, { marginBottom: 4 }]}>Ishlatildi</Text>
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
          {range && editable && <Text style={{ color: outside ? C.err : C.muted }}>Ruxsat etilgan: {fmtQty(range.min ?? 0)} – {range.max == null ? '∞' : fmtQty(range.max)} kg{outside ? ' — chegaradan tashqarida, rahbar tasdiqlaydi' : ''}</Text>}
          {t.status === 'approval' && <Text style={{ color: C.warn }}>Chiqish chegaradan tashqarida. Rahbar tasdiqlashini kuting.</Text>}
        </View>
        {editable && !!r?.rates?.length && (
          <View style={[s.card, { gap: 8 }]}>
            <Text style={s.muted}>Kim bilan birga bajardingiz? (ishbay haq teng bo'linadi)</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {(meta?.staff ?? []).map((u) => (
                <Chip key={u.id} label={u.id === me?.id ? `${u.name} (men)` : u.name} on={team.includes(u.id)}
                  onPress={() => setWorkers(team.includes(u.id) ? (team.length > 1 ? team.filter((x) => x !== u.id) : team) : [...team, u.id])} />
              ))}
            </View>
            <Text style={s.muted}>{team.length} kishi</Text>
          </View>
        )}
        {editable && (
          <View style={[s.card, { gap: 8 }]}>
            <Text style={s.muted}>Tayyor mahsulot qayerga o'tadi?</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              <Chip label="O'zimda qoladi" on={!target} onPress={() => setSendTo(null)} />
              {places.map((w) => <Chip key={w.id} label={w.name} on={target?.warehouseId === w.id} onPress={() => setSendTo({ warehouseId: w.id })} />)}
            </View>
            {!!target && <Text style={s.muted}>Mas'ul xodim qabul qilgach o'tadi.</Text>}
          </View>
        )}
        {editable && <Btn title={busy ? '...' : 'Yakunlash'} onPress={finish} disabled={busy || !(outWeight > 0 || outs.some((o) => toNumber(out[o.productId] || 0) > 0))} />}
        {(t.status === 'open' || t.status === 'done' || t.status === 'approval') && <Btn title="Bekor qilish" kind="warn" onPress={cancel} />}
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------- close the shift
export function CloseShift({ onBack, onDone }) {
  const { data, err } = useLoad(async () => {
    const [{ shift }, meta] = await Promise.all([prod('GET', '/shift'), api.erp('GET', '/meta')]);
    return { shift, meta };
  }, []);
  const [returned, setReturned] = useState('');
  const [wh, setWh] = useState(null);
  const [loss, setLoss] = useState({});
  const [busy, setBusy] = useState(false);
  if (!data?.shift) return <View style={{ flex: 1 }}><Header title="Smenani yopish" onBack={onBack} /><Err err={err} /></View>;
  const { shift, meta } = data;
  const reasons = meta.techReasons ?? [];
  const whs = meta.warehouses.filter((w) => w.kind === 'raw_milk').concat(meta.warehouses.filter((w) => w.kind !== 'raw_milk'));
  const whId = wh ?? whs[0]?.id;
  const inHands = shift.milk.in_hands;
  const explained = toNumber(returned || 0) + reasons.reduce((a, r) => a + toNumber(loss[r.id] || 0), 0);
  const left = Math.round((inHands - explained) * 1000) / 1000;
  const openTasks = shift.tasks.filter((t) => t.status === 'open' || t.status === 'approval');
  // Pourers and cappers use no milk: nothing to explain, the shift just closes.
  const noMilk = inHands === 0 && shift.milk.used === 0;

  const submit = async () => {
    setBusy(true);
    try {
      const res = await prod('POST', `/shifts/${shift.id}/close`, {
        returned: toNumber(returned || 0), returnTo: { warehouseId: whId },
        losses: reasons.map((r) => ({ reasonId: r.id, qty: toNumber(loss[r.id] || 0) })).filter((l) => l.qty > 0),
      });
      onDone(res.needApproval ? 'Yo\'qotish limitdan oshgan — smena rahbar tasdig\'iga yuborildi' : `${shift.label} yopildi${toNumber(returned || 0) > 0 ? '. Qolgan sutni omborchi qabul qiladi.' : ''}`);
    } catch (e) { notify('Xatolik', e.message); } finally { setBusy(false); }
  };
  return (
    <View style={{ flex: 1 }}>
      <Header title={`${shift.label} — yopish`} onBack={onBack} />
      <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }} keyboardShouldPersistTaps="handled">
        {openTasks.length > 0 && <Text style={s.err}>Avval ochiq topshiriqlarni yakunlang: {openTasks.map((t) => t.label).join(', ')}</Text>}
        {noMilk ? (
          <View style={[s.card, { gap: 6 }]}>
            <Text style={s.text}>Bu smenada sut ishlatilmagan.</Text>
            <Text style={s.muted}>Qo'lingizda qolgan mahsulotni (quyma, idish...) "Ombor" bo'limida omborga yoki keyingi xodimga topshiring.</Text>
          </View>
        ) : (
          <>
        <View style={[s.card, { gap: 6 }]}>
          <Text style={s.text}>Hisob bo'yicha qo'lingizda: <Text style={{ fontWeight: '700' }}>{fmtQty(inHands)} kg</Text> {shift.milk.product}</Text>
          <Text style={s.muted}>Topshiriqlarda ishlatildi {fmtQty(shift.milk.used)} kg. Qolgan sut qayerga ketganini yozing.</Text>
        </View>
        <View style={[s.card, { gap: 8 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={[s.text, { flex: 1 }]}>Omborga qaytaraman</Text>
            <Num value={returned} onChange={setReturned} unit="kg" />
          </View>
          {toNumber(returned || 0) > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {whs.map((w) => <Chip key={w.id} label={w.name} on={w.id === whId} onPress={() => setWh(w.id)} />)}
            </View>
          )}
        </View>
        <View style={[s.card, { gap: 8 }]}>
          <Text style={s.muted}>Yo'qotish sababi (bir nechta bo'lishi mumkin)</Text>
          {reasons.map((r) => {
            const allowed = r.limit_qty != null && r.limit_base > 0 ? (r.limit_qty * shift.milk.used) / r.limit_base : null;
            const v = toNumber(loss[r.id] || 0);
            return (
              <View key={r.id} style={{ gap: 2 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={[s.text, { flex: 1 }]}>{r.name}</Text>
                  <Num value={loss[r.id] ?? ''} onChange={(x) => setLoss((l) => ({ ...l, [r.id]: x }))} unit="kg" />
                </View>
                {allowed != null && <Text style={{ fontSize: 13, color: v > allowed + 0.0005 ? C.err : C.muted }}>Limit: {fmtQty(Math.round(allowed * 1000) / 1000)} kg gacha{v > allowed + 0.0005 ? ' — oshib ketdi, rahbar tasdiqlaydi' : ''}</Text>}
              </View>
            );
          })}
        </View>
        <Text style={{ fontSize: 18, fontWeight: '700', color: left > 0.0005 ? C.err : left < -0.0005 ? C.ok : C.ok }}>
          {left > 0.0005 ? `Hisobsiz qoldi: ${fmtQty(left)} kg` : left < -0.0005 ? `Yutish: +${fmtQty(-left)} kg (hisobdagidan ko'p)` : 'Hammasi hisoblandi'}
        </Text>
          </>
        )}
        <Btn title={busy ? '...' : 'Smenani yopish'} onPress={submit} disabled={busy || left > 0.0005 || openTasks.length > 0} />
      </ScrollView>
    </View>
  );
}
