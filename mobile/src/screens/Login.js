import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Text, TextInput } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as api from '../api';
import { Logo } from '../components';
import { C, s } from '../ui';

const FORGOT_MSG = 'Men "Yaya" ilovasidagi parolimni unutdim';
const SUPPORT_TG = 'https://t.me/abdullayevder';

// One login screen for everybody. The login and password identify the person;
// the app then opens exactly the sections their role allows.
export default function Login({ onDone }) {
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(() => api.takeLogoutReason() ?? '');
  const [copied, setCopied] = useState(false);
  const [taps, setTaps] = useState(0);
  const [url, setUrl] = useState(api.getServerUrl());
  const [brand, setBrand] = useState(api.getBrand());

  useEffect(() => { api.refreshBrand().then(setBrand); }, []);

  const submit = async () => {
    if (!id || !secret || busy) return;
    setBusy(true);
    setErr('');
    try {
      if (taps >= 5) api.setServerUrl(url);
      await api.login(id, secret);
      onDone();
    } catch (e) {
      setErr(e.offline ? 'Internet yo\'q yoki server javob bermadi' : e.message);
    } finally {
      setBusy(false);
    }
  };

  // Telegram can't pre-type a message into a user chat, so the text is copied to
  // the clipboard and the support chat is opened — the person just pastes and sends.
  const forgot = async () => {
    try { await Clipboard.setStringAsync(FORGOT_MSG); setCopied(true); } catch { /* ignore */ }
    Linking.openURL(SUPPORT_TG).catch(() => {});
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[s.pad, { flexGrow: 1, justifyContent: 'center', gap: 16 }]} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => setTaps((t) => t + 1)} style={{ alignItems: 'center', gap: 8 }}>
          <Logo size={brand.logo ? 96 : 0} />
          <Text style={[s.h1, { fontSize: 36, color: C.accent, textAlign: 'center' }]}>{brand.companyName || 'Yaya'}</Text>
        </Pressable>
        {taps >= 5 && (
          <TextInput style={s.input} value={url} onChangeText={setUrl} placeholder="https://server-manzili" placeholderTextColor={C.placeholder}
            autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        )}
        <TextInput style={s.input} value={id} onChangeText={setId} placeholder="Login" placeholderTextColor={C.placeholder}
          autoCapitalize="none" autoCorrect={false} autoComplete="username" textContentType="username" />
        <TextInput style={s.input} value={secret} onChangeText={setSecret} placeholder="Parol" placeholderTextColor={C.placeholder}
          secureTextEntry autoCapitalize="none" autoComplete="password" textContentType="password" onSubmitEditing={submit} />
        {!!err && <Text style={s.err}>{err}</Text>}
        <Pressable style={[s.btn, (busy || !id || !secret) && { opacity: 0.6 }]} onPress={submit} disabled={busy || !id || !secret}>
          <Text style={s.btnText}>{busy ? 'Kirilmoqda...' : 'Kirish'}</Text>
        </Pressable>
        <Pressable onPress={forgot} hitSlop={10} style={{ alignItems: 'center' }}>
          <Text style={[s.muted, { fontSize: 13, textDecorationLine: 'underline' }]}>Parol esdan chiqdi</Text>
        </Pressable>
        {copied && <Text style={[s.muted, { fontSize: 12, textAlign: 'center' }]}>Xabar nusxalandi — Telegramda qo'ying va jo'nating</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
