import { redirect } from 'next/navigation';

// Self-registration is disabled — users are created by an admin.
export default function RegisterPage() {
  redirect('/login');
}
