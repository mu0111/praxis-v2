import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { trackEvent } from '../lib/analytics';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info);
    // No crash reporter is wired up; record the message so a crash someone
    // only sees on their phone can still be diagnosed from analytics_events.
    void trackEvent('app_error', {
      message: String(error?.message ?? error).slice(0, 500),
      stack: (error?.stack ?? '').slice(0, 2000),
      component_stack: (info?.componentStack ?? '').slice(0, 2000),
    });
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <View style={s.container}>
          <Text style={s.icon}>⚠️</Text>
          <Text style={s.title}>Something went wrong</Text>
          <Text style={s.body}>{this.state.error?.message ?? 'An unexpected error occurred.'}</Text>
          <TouchableOpacity style={s.btn} onPress={this.reset}>
            <Text style={s.btnText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const s = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12, backgroundColor: '#14161B' },
  icon: { fontSize: 48 },
  title: { fontSize: 20, fontWeight: '700', color: '#F5F9FC' },
  body: { fontSize: 14, color: '#8891A4', textAlign: 'center', lineHeight: 20 },
  btn: { marginTop: 8, backgroundColor: '#3B82F6', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  btnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
});
