import ErrorScreen from '@/components/ErrorScreen';

export default function NotFound() {
  return (
    <div className="h-full flex">
      <ErrorScreen code="404" title="Pagina niet gevonden" text="Deze pagina bestaat niet (meer). Misschien is de link veranderd of is het gesprek verwijderd." />
    </div>
  );
}
