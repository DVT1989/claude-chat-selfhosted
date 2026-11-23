export const metadata = { title: 'Privacybeleid - Claude Chat' };

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px', lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, marginBottom: 16 }}>Privacybeleid Claude Chat</h1>
      <p>Claude Chat (claude.example.com) is een persoonlijke assistent-app voor een beperkte groep uitgenodigde gebruikers. Dit beleid beschrijft welke gegevens de app gebruikt.</p>
      <h2 style={{ fontSize: 20, marginTop: 28 }}>Google-gegevens</h2>
      <p>Als je een Google-account koppelt, vraagt de app alleen leesrechten op Google Search Console (scope webmasters.readonly). De app leest daarmee zoekprestaties, sites en indexatiestatus van sites waar jij toegang toe hebt. De app wijzigt niets in je Google-account.</p>
      <p>Het toegangstoken wordt versleuteld opgeslagen op de eigen server van de beheerder en alleen gebruikt om op jouw verzoek gegevens op te halen. Gegevens uit Google worden niet verkocht, niet gedeeld met derden en niet gebruikt voor advertenties. Het gebruik van informatie die van Google API&apos;s wordt ontvangen, voldoet aan de Google API Services User Data Policy, inclusief de Limited Use-vereisten.</p>
      <h2 style={{ fontSize: 20, marginTop: 28 }}>Overige gegevens</h2>
      <p>De app bewaart je account (naam en e-mailadres), gesprekken en koppelingen in een eigen database. Voor het beantwoorden van vragen wordt de inhoud van een gesprek verwerkt door het taalmodel Claude van Anthropic.</p>
      <h2 style={{ fontSize: 20, marginTop: 28 }}>Intrekken en verwijderen</h2>
      <p>Je kunt de koppeling op elk moment verwijderen in de app (Koppelingen), of de toegang intrekken via myaccount.google.com/permissions. Opgeslagen tokens worden dan gewist. Voor verwijdering van je account of gegevens neem je contact op met de beheerder: admin@example.com.</p>
      <p style={{ marginTop: 28, opacity: 0.7 }}>Laatst bijgewerkt: 22 november 2026</p>
    </main>
  );
}
