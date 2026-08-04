/* Stammbauminator — Kurzanleitung
   Globals: window.HelpView

   Der Text richtet sich an die ganze Familie, von den Kindern bis zu den
   Grosseltern. Darum: kurze Sätze, keine Fachbegriffe, keine Erklärungen dazu,
   wie etwas technisch funktioniert. Adminfunktionen kommen bewusst nicht vor —
   die betreffen nur eine Person. */
(function () {
  'use strict';

  const GUIDE = [
    {
      icon: '🌳',
      title: 'Jemanden zum Stammbaum hinzufügen',
      blocks: [
        'Damit der Baum übersichtlich bleibt, sind die Knöpfe zum Eintragen normalerweise nicht zu sehen.',
        'Tippe zuerst oben auf <b>«Person hinzufügen»</b>. Erst dann erscheinen überall im Baum kleine runde Knöpfe mit einem Bild darauf.',
        { list: [
          'Das <b>grüne Fläschchen</b> 🍼 unterhalb eines Paares fügt ein <b>Kind</b> hinzu.',
          'Das <b>blaue Herz</b> ❤️ neben einer Person fügt eine <b>Partnerin</b> oder einen <b>Partner</b> hinzu.'
        ] },
        'Bist du fertig, tippst du auf <b>«Hinzufügen beenden»</b> — dann sind die Zeichen wieder weg und du siehst nur noch den Baum. Beim nächsten Öffnen der App sind sie ohnehin wieder verborgen.',
        'Jede Person hat höchstens ein Herz. Es steht dort, wo die nächste Partnerschaft Platz hat — fahr mit der Maus darüber, dann siehst du, um wen es geht.',
        'Ein Fläschchen gibt es nur bei <b>laufenden</b> Partnerschaften. Musst du ausnahmsweise ein Kind zu einer früheren nachtragen, stell sie kurz auf «aktuell», trag das Kind ein und stell sie zurück.',
        'Ausfüllen musst du nur den Vornamen. Alles andere darf später dazukommen — auch von jemand anderem.'
      ]
    },
    {
      icon: '📸',
      title: 'Jemanden auf einem Foto markieren',
      blocks: [
        'Geh ins <b>Fotoalbum</b> und tippe ein Foto an. Dann tippst du im Bild direkt auf die Person.',
        'Es erscheint eine Liste — such den Namen heraus.',
        'Ist die Person noch gar nicht im Stammbaum? Dann wähle <b>«Neue Person anlegen»</b>, schreib den Namen und sag, wessen Kind sie ist. Sie steht danach automatisch auch im Stammbaum.',
        'Stehen die Leute dicht beieinander und du kommst mit dem Finger nicht dazwischen? Dann setz die Markierung einfach irgendwo daneben, wo Platz ist, und rück sie danach zurecht (siehe unten).',
        { hint: 'Zum Vergrössern gibt es <b>＋</b> und <b>－</b> oben rechts — oder zwei Finger. Bis zum Vierfachen. Die Punkte und Namen bleiben dabei gleich gross, damit sie die Gesichter nicht verdecken.' },
        'Tippst du <b>unter dem Bild</b> auf einen Namen, wird nur noch diese eine Markierung gezeigt und die Angaben zur Person gehen auf. Nochmals tippen zeigt wieder alle.'
      ]
    },
    {
      icon: '✎',
      title: 'Markierungen verschieben oder löschen',
      blocks: [
        'Normalerweise öffnet ein Tipp auf eine Markierung die Person — das ist ja, was man meistens wissen will. Damit beim Zoomen nichts aus Versehen verrutscht, bleiben die Markierungen dabei <b>liegen</b>.',
        'Willst du sie zurechtrücken oder wegnehmen, schaltest du oben rechts auf <b>«Markierungen bearbeiten»</b>. Dann gilt:',
        { list: [
          'Jede Markierung lässt sich <b>ziehen</b> — die Punkte werden gelb, damit du siehst, dass sie beweglich sind.',
          'An jeder Markierung steht ein <b>✕</b> zum Entfernen. Die Person selbst bleibt dabei im Stammbaum.',
          'Ein Tipp auf eine Markierung öffnet in diesem Modus <b>keine</b> Angaben mehr — sonst käme man beim Ziehen ständig ins Gehege.'
        ] },
        'Fertig? <b>«Bearbeiten beenden»</b> antippen (oder <b>Esc</b> drücken). Danach öffnet ein Tipp wieder die Person.',
        { hint: 'Ins Bild tippen legt auch im Bearbeiten-Modus eine neue Markierung an — das geht immer.' }
      ]
    },
    {
      icon: '✏️',
      title: 'Angaben ändern und ein Portrait hochladen',
      blocks: [
        'Tippe im Stammbaum auf eine Person. Es geht ein Feld auf mit Adresse, Telefon, Geburtstag und der ganzen Verwandtschaft.',
        'Über <b>«Bearbeiten»</b> änderst und ergänzt du alles. Dort lädst du auch ein <b>Portraitfoto</b> hoch.',
        'Und ganz wichtig: <b>Alles davon ist freiwillig.</b> Ob du Adresse, Telefon, Geburtstag oder ein Portrait einträgst, entscheidest du allein. Trag ein, womit du dich wohl fühlst, und lass ruhig leer, was sonst niemanden etwas angeht. Das hier soll das Nachschlagen bequemer machen — mitmachen muss niemand.',
        { hint: 'Kein Portrait zur Hand? Dann nimmt die App automatisch einen Ausschnitt aus einem Gruppenfoto, auf dem die Person markiert ist. Je mehr Leute auf den Fotos markiert sind, desto besser werden diese Ausschnitte.' }
      ]
    },
    {
      icon: '🧠',
      title: 'Namen lernen',
      blocks: [
        'So viele Verwandte — wer soll sich die alle merken? Dafür gibt es <b>Namen lernen</b>.',
        'Du wählst aus, von wem du die Nachkommen lernen möchtest und über wie viele Generationen. Dann bekommst du Kärtchen mit Gesichtern.',
        'Tippe auf das Bild, um das Kärtchen umzudrehen und den Namen zu sehen. Dann sag ehrlich: <b>«Wusste ich»</b> oder <b>«Wusste ich noch nicht»</b>.',
        'Was du wusstest, ist weg. Der Rest kommt später nochmals — so lange, bis er sitzt.'
      ]
    },
    {
      icon: '💡',
      title: 'Kleine Hilfen',
      blocks: [
        { list: [
          '<b>Datum:</b> 01.01.2000. Wenn du den Tag nicht kennst, reicht auch nur das Jahr.',
          '<b>Das Schildchen «aktuell» oder «früher»</b> zwischen zwei Personen antippen: Dort stellst du ein, ob eine Partnerschaft noch läuft. Das Schildchen ist immer da. Nicht verwechseln mit dem runden Herz-Knopf, den es nur bei <b>«Person hinzufügen»</b> gibt — der legt eine <b>neue</b> Partnerschaft an.',
          '<b>Den Baum bewegen:</b> mit dem Finger oder der Maus ziehen. Mit + und − zoomst du, der Doppelpfeil zeigt alles auf einmal.',
          '<b>Ausdrucken:</b> Weil der Stammbaum mit der Zeit etwas unübersichtlich wird, kannst du ihn mit dem Drucker-Knopf komprimiert auf Papier bringen — alles quer auf ein A4-Blatt.',
          '<b>Jemanden suchen:</b> oben den Namen ins Suchfeld tippen.'
        ] }
      ]
    }
  ];

  const HelpView = {
    open() {
      const body = document.createElement('div');
      body.className = 'help';

      const intro = document.createElement('p');
      intro.className = 'help__intro';
      intro.textContent = 'Hier wächst unser Familienstammbaum — und alle dürfen mitmachen. '
        + 'Trau dich ruhig: Du kannst nichts kaputt machen.';
      body.appendChild(intro);

      for (const section of GUIDE) {
        body.appendChild(renderSection(section));
      }

      const outro = document.createElement('p');
      outro.className = 'help__outro';
      outro.textContent = 'Viel Spass! Wenn etwas klemmt oder du eine Frage hast, meld dich bei der Person, die die App betreut.';
      body.appendChild(outro);

      App.modal({
        title: 'So funktioniert’s',
        body,
        actions: [{ label: 'Alles klar', variant: 'primary' }]
      });
    }
  };

  function renderSection(section) {
    const wrap = document.createElement('section');
    wrap.className = 'help__section';

    const heading = document.createElement('h3');
    heading.className = 'help__title';

    const icon = document.createElement('span');
    icon.className = 'help__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = section.icon;

    const text = document.createElement('span');
    text.textContent = section.title;

    heading.append(icon, text);
    wrap.appendChild(heading);

    for (const block of section.blocks) {
      if (typeof block === 'string') {
        wrap.appendChild(paragraph(block));
      } else if (block.list) {
        const ul = document.createElement('ul');
        ul.className = 'help__list';
        for (const item of block.list) {
          const li = document.createElement('li');
          li.innerHTML = emphasise(item);
          ul.appendChild(li);
        }
        wrap.appendChild(ul);
      } else if (block.hint) {
        const p = paragraph(block.hint);
        p.className = 'help__hint';
        wrap.appendChild(p);
      }
    }

    return wrap;
  }

  function paragraph(html) {
    const p = document.createElement('p');
    p.innerHTML = emphasise(html);
    return p;
  }

  /**
   * Der Anleitungstext steht als Konstante in dieser Datei und enthält nur
   * <b>-Auszeichnungen — er stammt nie von Nutzereingaben. Trotzdem wird hier
   * alles ausser <b> entschärft, damit ein späterer Textzusatz nicht
   * versehentlich Markup einschleusen kann.
   */
  function emphasise(raw) {
    return String(raw)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/&lt;b&gt;/g, '<b>')
      .replace(/&lt;\/b&gt;/g, '</b>');
  }

  window.HelpView = HelpView;
})();
