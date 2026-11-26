import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { getSyncState, onSyncState, syncNow } from './api';
import * as store from './db';
import { Btn, fmtDT } from './components';
import { C, fmtTime, s } from './ui';
import { ask } from './dialog';

const KIND = { shift: 'Smena', pickup: 'Sut yozuvi', fix: 'Tuzatish', payment: "To'lov" };

// One-line status: tells the collector at a glance whether everything reached the office.
// When the server refused something, tapping the red bar lists each refused entry with
// the reason; the person can retry, or discard an entry (or all) so the bar goes away.
export default function SyncBar({ tick }) {
  const [st, setSt] = useState(getSyncState());
  const [open, setOpen] = useState(false);
  const [, bump] = useState(0);
  useEffect(() => onSyncState(setSt), []);
  const pending = store.unsyncedCount();
  const errors = store.errorCount();
  void tick;

  let color = C.ok;
  let text = 'Hammasi yuborilgan ✓';
  if (errors) { color = C.err; text = `${errors} ta yozuv serverga yuborilmadi — bosing`; }
  else if (st.syncing) { color = C.muted; text = 'Yuborilmoqda...'; }
  else if (pending) { color = C.warn; text = `${pending} ta yozuv qurilma xotirasiga saqlandi${st.online ? ' — bosing' : " · internet yo'q"}`; }
  if (!errors && !pending && st.lastSync) text += `  · ${fmtTime(st.lastSync)}`;

  const items = open ? store.errorDetails() : [];
  const waiting = open ? store.pendingDetails() : [];
  // syncNow() also re-renders the whole screen (lists, open shift) after a discard.
  const refresh = () => { bump((n) => n + 1); if (!store.errorCount() && !store.unsyncedCount()) setOpen(false); syncNow(); };
  const discard = (e) => ask('Bekor qilish', `"${e.title}" — ${e.detail}\n\nBu yozuv qurilmadan o'chiriladi va serverga yuborilmaydi.${
    e.kind === 'fix' ? ' (Qurilmadagi qiymat serverdagidan farq qilishi mumkin.)' : ''}`, 'Bekor qilish', () => { store.discardError(e.kind, e.uuid); refresh(); });

  return (
    <>
      <Pressable onPress={() => { if (errors || pending) setOpen(true); else syncNow(); }}>
        <View style={{ backgroundColor: color, paddingVertical: 8, paddingHorizontal: 16 }}>
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>{text}</Text>
        </View>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: '#0008', justifyContent: 'center', padding: 16 }}>
          <Pressable onPress={() => {}} style={[s.card, { gap: 10, maxHeight: '85%' }]}>
            <Text style={s.h2}>Yuborilmagan yozuvlar</Text>
            <Text style={s.muted}>Har bir yozuvning o'z raqami bor: qayta yuborilsa ham serverda ikki marta saqlanmaydi.</Text>
            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8 }}>
              {waiting.map((e) => (
                <View key={`w${e.kind}${e.uuid}`} style={[s.card, { padding: 12, gap: 4, borderColor: C.warn }]}>
                  <Text style={[s.muted, { fontSize: 13 }]}>⏳ {KIND[e.kind]} · {fmtDT(e.when)} · qurilma xotirasida</Text>
                  <Text style={[s.text, { fontWeight: '700' }]}>{e.title}</Text>
                  <Text style={s.text}>{e.detail}</Text>
                  {!e.keep && <Btn title="Bekor qilish" kind="warn" style={{ marginTop: 4, paddingVertical: 8 }} onPress={() => discard(e)} />}
                </View>
              ))}
              {items.map((e) => (
                <View key={`${e.kind}${e.uuid}`} style={[s.card, { padding: 12, gap: 4, borderColor: C.err }]}>
                  <Text style={[s.muted, { fontSize: 13 }]}>{KIND[e.kind]} · {fmtDT(e.when)}</Text>
                  <Text style={[s.text, { fontWeight: '700' }]}>{e.title}</Text>
                  <Text style={s.text}>{e.detail}</Text>
                  <Text style={{ color: C.err, fontSize: 15 }}>Sabab: {e.error}</Text>
                  <Btn title="Bekor qilish" kind="warn" style={{ marginTop: 4, paddingVertical: 8 }} onPress={() => discard(e)} />
                </View>
              ))}
            </ScrollView>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn title="Qayta sinxronlash" kind="ghost" style={{ flex: 1 }} onPress={() => { store.retryErrors(); setOpen(false); syncNow(); }} />
              {items.length > 0 && <Btn title="Xatolarni tozalash" kind="warn" style={{ flex: 1 }}
                onPress={() => ask('Tozalash', `${items.length} ta server qabul qilmagan yozuv qurilmadan o'chiriladi.`, 'Tozalash', () => { store.discardAllErrors(); refresh(); })} />}
            </View>
            <Btn title="Yopish" kind="ghost" onPress={() => setOpen(false)} />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
