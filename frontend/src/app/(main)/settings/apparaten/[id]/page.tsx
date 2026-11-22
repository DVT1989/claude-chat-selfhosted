'use client';

import { useParams } from 'next/navigation';
import DeviceDetail from '@/components/devices/DeviceDetail';

export default function DevicePage() {
  const { id } = useParams<{ id: string }>();
  return <DeviceDetail id={id} />;
}
