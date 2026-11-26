import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import * as api from './api';
import { Btn, fmtDT } from './components';
import { ask } from './dialog';
import { C, s } from './ui';

// Header badge for the offline outbox: "⏳ 2" while documents wait for the
// internet, "⚠ 1" for those the server refused — tap to see why and remove them.
export function OutboxBadge() {
  const [, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => api.onOutbox(() => setTick((t) => t + 1)), []);
  const waiting = api.getOutbox();
  const failed = api.getOutboxFailed();
  if (!waiting.length && !failed.length) return null;
  return (
    <>
      <Pressable onPress={() => setOpen(true)} hitSlop={8}
        style={{ borderRadius: 99, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: failed.length ? C.err : C.warn }}>
        <Text style={{ color: '#fff', fontWeight: '700' }}>{failed.length ? `⚠ ${failed.length}` : `⏳ ${waiting.length}`}</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 16 }}>
          <View style={[s.card, { maxHeight: '85%', gap: 10 }]}>
            <Text style={s.h2}>Yuborilmagan hujjatlar</Text>
            <ScrollView contentContainerStyle={{ gap: 8 }}>
              {waiting.map((x) => (
                <View key={x.id} style={{ borderBottomWidth: 1, borderColor: C.line, paddingBottom: 6 }}>
                  <Text style={s.text}>⏳ {x.label}</Text>
                  <Text style={s.muted}>{x.user} · {fmtDT(x.at)} · qurilma xotirasida, internet chiqqanda o'zi yuboriladi</Text>
                  <Pressable onPress={() => ask('Bekor qilish', `"${x.label}" qurilmadan o'chiriladi va serverga yuborilmaydi.`, 'Bekor qilish', () => api.dropWaiting(x.id))}>
                    <Text style={{ color: C.err, marginTop: 2 }}>Bekor qilish</Text>
                  </Pressable>
                </View>
              ))}
              {failed.map((x) => (
                <View key={x.id} style={{ borderBottomWidth: 1, borderColor: C.line, paddingBottom: 6, gap: 4 }}>
                  <Text style={s.text}>⚠ {x.label}</Text>
                  <Text style={s.muted}>{x.user} · {fmtDT(x.at)}</Text>
                  <Text style={s.err}>Server qabul qilmadi: {x.error}</Text>
                  <Btn title="Ro'yxatdan olib tashlash" kind="warn" onPress={() => api.dropFailed(x.id)} />
                </View>
              ))}
            </ScrollView>
            <Text style={s.muted}>Har bir hujjatning o'z raqami bor: qayta yuborilsa ham serverda ikki marta saqlanmaydi.</Text>
            {waiting.length > 0 && <Btn title="Qayta sinxronlash" kind="ghost" onPress={() => api.flushOutbox()} />}
            <Btn title="Yopish" onPress={() => setOpen(false)} />
          </View>
        </View>
      </Modal>
    </>
  );
}
