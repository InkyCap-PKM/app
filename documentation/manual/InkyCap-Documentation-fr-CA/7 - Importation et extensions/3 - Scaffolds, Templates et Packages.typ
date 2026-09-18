#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Scaffolds, Templates et Packages",
  description: "Comment utiliser les scaffolds, les règles de création, ainsi que les templates et packages Typst pour donner à vos notes des points de départ réutilisables et puiser dans l'écosystème Typst.",
  tags: ("documentation",),
)

= Scaffolds, Templates et Packages

InkyCap vous offre trois sortes de points de départ réutilisables (_scaffolds_, _templates de document_ et _packages_), plus des _règles de création_ qui les appliquent automatiquement. Si vous aimeriez qu'une nouvelle note contienne déjà du contenu ou une mise en forme pré-remplis, ou si vous souhaitez l'allure soignée d'un article publié sans avoir à retoucher la mise en page, c'est ici que vous configurez tout cela.

Les trois idées sont liées, mais distinctes :

- *Scaffold*. Un extrait de contenu de note (avec des espaces à remplir) que vous déposez _dans_ une note. Pensez à un « point de départ pour le journal du jour ». Un scaffold peut aussi inclure un template ou des packages. Les scaffolds sont propres à InkyCap.
- *Template*. Une enveloppe de document complet qui contrôle la mise en page, les polices et le style, à la manière du style de soumission d'une revue.
- *Package*. Une bibliothèque Typst réutilisable qui ajoute des capacités (diagrammes, blocs de code raffinés, et ainsi de suite).

Les trois vivent ensemble au même endroit : le panneau *Scaffolds, templates et packages*.

== Ouvrir le panneau

Sur la barre d'outils verticale, le long du bord de la fenêtre, cliquez sur le bouton à l'icône de gabarit de mise en page (son infobulle indique *« Scaffolds, templates et packages »*). Cela ouvre un volet dans la barre latérale de gauche avec trois boutons en haut qui permettent de passer entre *Scaffolds*, *Templates de Typst* et *Packages de Typst* (survolez un bouton pour voir son nom).

Deux contrôles d'en-tête existent :

- *Actualiser* réanalyse votre boîte de notes à la recherche de scaffolds et de packages, au cas où vous en auriez ajouté hors de l'application.
- La bascule *Info* (aide) affiche une courte explication propre à l'onglet, directement dans le panneau. Elle est désactivée par défaut ; activez-la quand vous voulez un rappel de ce que fait un onglet.

== Scaffolds

Un scaffold n'est qu'un contenu de note que vous réutilisez. InkyCap en vient avec deux, et vous pouvez ajouter les vôtres.

Les deux scaffolds intégrés sont *new-note* (le point de départ standard derrière chaque nouvelle note) et *daily-note* (un point de départ daté idéal pour la tenue d'un journal ; voir #wikilink("4 - Rouleau de journal")). Ceux-ci sont semés dans votre boîte de notes la première fois que vous l'ouvrez, puis laissés tranquilles, mais vous pouvez les personnaliser. Ils ne peuvent pas être supprimés, puisque les règles de création intégrées en dépendent.

=== Insérer un scaffold dans une note

Avec une note ouverte, appuyez sur le raccourci `Ctrl+Shift+\` pour faire apparaître le sélecteur *Insérer un scaffold*. Commencez à taper pour filtrer vos choix (si vous avez créé de nombreux scaffolds), utilisez les flèches haut et bas pour choisir, appuyez sur Entrée pour insérer et sur Échap pour annuler. (Vous pouvez aussi lancer *Insérer un scaffold* depuis la palette de commandes.) Si vous ouvrez le sélecteur dans un onglet vide plutôt que dans une note, choisir un scaffold crée une toute nouvelle note dont le corps est ce scaffold, en utilisant la règle de création *Nouvelle note* pour le dossier et le nom de fichier.

Quand vous insérez, le contenu du scaffold est ajouté à la fin de votre note, avec tout espace à remplir comblé sur-le-champ à ce moment-là (par exemple, une variable pour le titre ajoutera le titre que vous avez donné à la note). Si la note actuelle était vide, le scaffold la remplit.

Si le scaffold commence par des propriétés de note, celles-ci sont fusionnées avec les propriétés existantes de votre note ; vos valeurs existantes sont conservées, et toute nouvelle clé est ajoutée.

=== Créer votre propre scaffold

+ Dans l'onglet Scaffolds, cliquez sur *Nouveau*.
+ Donnez-lui un nom de fichier (par exemple, `meeting-notes`). Vous pouvez omettre le `.typ` ; InkyCap l'ajoute.
+ Le nouveau scaffold s'ouvre dans un onglet, pré-rempli d'un point de départ que vous pouvez modifier librement. Ce point de départ commence par la même ligne d'importation que porte chaque note, de sorte que votre scaffold compile comme n'importe quelle autre note.

Pour revisiter un scaffold plus tard, cliquez sur sa ligne dans la liste pour l'ouvrir. Pour retirer un scaffold dont vous n'avez plus besoin, cliquez sur l'icône de corbeille sur sa ligne. InkyCap vous demande de confirmer et, si des règles de création pointent encore vers ce scaffold, il les énumère : ces règles continuent de fonctionner, mais créeront des notes sans le contenu du scaffold tant que vous ne les pointez pas vers un autre. Le scaffold est déplacé vers la corbeille plutôt que supprimé pour de bon.

=== Espaces à remplir

Les scaffolds (et plusieurs champs des règles de création) comprennent les espaces à remplir `{{...}}` qui sont comblés au moment où le scaffold est utilisé.

- `{{title}}` est le titre de la note.
- `{{filename}}` est le nom du fichier de la note sur le disque.
- `{{slug}}` est une version soignée et compatible avec les URL du titre.
- `{{date}}` est la date d'aujourd'hui au format `YYYY-MM-DD`.
- `{{date:FORMAT}}` est la date d'aujourd'hui dans un format que vous choisissez (voir ci-dessous).
- `{{time}}` et `{{time:FORMAT}}` donnent l'heure actuelle.
- `{{zid}}` est un identifiant Zettelkasten, si vous avez configuré ce motif.
- `{{cursor}}` marque l'endroit où votre curseur devrait atterrir à l'ouverture de la note.

Le format à l'intérieur de `{{date:...}}` utilise des jetons familiers : `YYYY` (année), `MM` (numéro du mois), `MMMM` (nom complet du mois), `DD` (jour), `dddd` (nom du jour de la semaine), `HH` et `mm` (heures et minutes), et ainsi de suite. Tout ce qui n'est pas un jeton passe tel quel, donc `{{date:D MMMM YYYY}}` vous donne quelque chose comme « 5 juin 2026 ». Les _noms_ des mois et des jours de la semaine suivent la langue de votre interface, donc une interface française afficherait « vendredi ».

#callout("note")[ Quand une note est créée par une _règle de création_ (la section suivante), votre curseur est placé sur une nouvelle ligne vide tout à la fin de la note, peu importe où se trouve `{{cursor}}`. ]

== Règles de création

Une règle de création est un préréglage pour fabriquer une nouvelle note. Au lieu de créer un fichier vide et de le configurer à la main chaque fois, une règle peut choisir le dossier, nommer le fichier, le remplir à partir d'un scaffold, appliquer un template et lier un raccourci clavier (le tout d'un coup). C'est ce qui rend possible le « appuyez sur une touche, obtenez l'entrée de journal datée d'aujourd'hui dans le bon dossier ».

Vous gérez les règles dans #wikilink("2 - Paramètres"), à l'onglet *Règles de création*. Comme le dit le panneau, les règles de création « simplifient les processus répétitifs de création de notes. » Les règles appartiennent à la boîte de notes (elles sont rangées dans son dossier `.inkycap`), donc elles voyagent avec elle.

=== Les deux règles intégrées

- *Nouvelle note* alimente le bouton « Nouvelle note » de l'arborescence de fichiers et le raccourci `Ctrl+N`. Elle est fondamentale, alors elle ne peut être ni supprimée ni désactivée.
- *Note du jour* crée (ou, si elle existe déjà, ouvre simplement) la note datée d'aujourd'hui dans un dossier `Daily/{{date:YYYY}}`, sur `Ctrl+D`. Elle apparaît comme un bouton de la barre d'outils par défaut. Vous ne pouvez pas la supprimer, mais vous _pouvez_ la désactiver si vous ne tenez pas de journal.

=== Construire votre propre règle

Cliquez sur *+ Nouvelle règle* et remplissez les champs qui comptent pour vous :

- *Nom* est obligatoire ; c'est ainsi que la règle s'appelle.
- *Icône* vous permet de choisir une petite icône, ou de taper votre propre libellé d'un ou deux caractères ou un émoji.
- *Modèle de nom de fichier* définit comment les nouveaux fichiers sont nommés. Utilisez des espaces à remplir comme `{{title}}` ou `{{date:YYYY-MM-DD}}`, ou laissez-le vide pour qu'on vous le demande chaque fois.
- *Dossier cible* est l'endroit où atterrissent les notes, relatif à la racine de votre boîte de notes. Laissez-le vide pour retomber sur votre « Emplacement des nouvelles notes » par défaut (défini sous Fichiers et liens ; voir #wikilink("3 - Configurer votre boîte de notes")). Il accepte aussi les espaces à remplir de date et de titre.
- *Fichier scaffold* est le scaffold (le cas échéant) qui remplit la nouvelle note. Deux boutons à côté du champ vous permettent de créer un nouveau scaffold ou de modifier celui qui est sélectionné dans une petite fenêtre d'édition, sans quitter les Paramètres.
- *Template Typst* est un template optionnel de document complet (couvert ci-dessous).
- *Mode de création* est « Créer et ouvrir » (le choix par défaut) ou « Créer seulement ».
- *Raccourci clavier* : cliquez pour enregistrer une combinaison de touches ; InkyCap refuse les combinaisons déjà liées à autre chose.
- *Afficher le bouton dans la barre d'outils* ajoute un bouton à un clic à la barre d'outils verticale.
- *Description* est une note optionnelle pour votre futur vous.

Enregistrez quand vous avez terminé. Le bouton *Restaurer les valeurs par défaut* re-sème les réglages d'origine d'une règle intégrée, ou ramène une règle personnalisée à un état vierge.

#callout("tip")[ Chaque règle active apparaît aussi dans la palette de commandes sous la catégorie *Règles de création*, donc vous pouvez la lancer sans mémoriser son raccourci. ]

#callout("note")[Lors du choix d'un template Typst pour une règle, une valeur commençant par `@` ou `/` est utilisée exactement telle que tapée (par exemple `@preview/charged-ieee:0.1.0`, ou un chemin à l'intérieur de la boîte de notes), et un nom simple comme `letter-layout` est traité comme le package local installé `@local/letter-layout:0.1.0`. ]

== Templates et packages <templates-and-packages>

Au-delà de vos propres extraits, InkyCap se connecte au plus vaste écosystème Typst : le *#link("https://typst.app/universe/")[Typst Universe]*, une bibliothèque publique de templates et de packages que tout le monde peut utiliser.

- *Templates de document* sont des enveloppes de document complet (taille de page, marges, polices, styles de titres). En appliquer un est la façon de faire en sorte qu'une note ait l'air d'un article de revue précis, d'un style de rapport, d'une présentation, d'un CV ou d'un autre type de document.
- *Packages* sont des bibliothèques qui ajoutent des fonctionnalités. Par exemple, CeTZ dessine des diagrammes ; codly enjolive les blocs de code ; Scorify affiche des partitions musicales ; il existe même des jeux et bien d'autres types de packages.

Les deux se gèrent à partir de leurs onglets respectifs dans le panneau, et les deux sont rangés ensemble à l'intérieur de votre boîte de notes pour voyager avec elle.

=== Installer depuis le Typst Universe

+ Ouvrez l'onglet *Packages de Typst* (ou *Templates de Typst* pour un template).
+ Cliquez sur *Installer* et entrez une spécification, comme `@preview/cetz:0.2.0`. La partie `@preview/` veut dire « du Typst Universe ».
+ InkyCap le récupère et indique combien de fichiers il a installés.

Chaque élément installé apparaît sous forme de ligne avec son nom, sa version et un badge d'origine (les éléments du Typst Universe affichent « Typst Universe » ; ceux que vous avez faits vous-même affichent « Votre package » ou « Votre template »). L'action *Copier* met la ligne d'importation exacte dans votre presse-papiers afin que vous puissiez la coller dans une note, et l'icône de corbeille le désinstalle. Avant de désinstaller, InkyCap énumère les règles de création qui utilisent le package et les notes qui l'importent, puisque ces notes ne compileront plus tant qu'il n'est pas réinstallé.

Vous pouvez aussi installer un template ou un package depuis une archive `.tar.gz` locale avec *Depuis un fichier*, ou créer votre propre point de départ avec *Nouveau*. C'est pratique si vous voulez bâtir un style maison pour vos propres écrits.

=== Comment fonctionnent les packages

InkyCap cherche les packages d'abord dans votre boîte de notes, puis dans la mémoire cache Typst partagée de votre ordinateur (la même mémoire cache qu'utilisent les outils Typst standards), afin que vos documents compilent de la même façon partout. Si une note importe un package du Universe que vous n'avez pas installé, InkyCap le télécharge (avec tout ce dont il dépend) et poursuit la compilation (_c'est un cas où InkyCap aurait besoin d'accéder à Internet_). Appliquer un template de document du Universe fonctionne de façon semblable.

#callout("tip", title: "Pour les utilisateurs de Typst")[ Les templates et les packages vivent sous `.inkycap/packages/<namespace>/<name>/<version>/`, là où le compilateur Typst s'attend à les trouver, et ce dossier n'est _pas_ ignoré par git. Importez une bibliothèque du Universe avec la ligne habituelle :

```typ
#import "@preview/cetz:0.2.0": *
```

Un package est traité comme un _template de document_ quand son `typst.toml` déclare une section `[template]` ; autrement, c'est une bibliothèque. L'espace de noms `@preview` est le registre public ; `@local/<name>:0.1.0` est pour les packages que vous créez vous-même (ceux-ci ne sont jamais téléchargés automatiquement ; il n'y a pas de registre d'où les récupérer). Le téléchargement automatique ne résout que les spécifications `@preview`, en les tirant ainsi que leurs dépendances transitives dans la mémoire cache Typst partagée avec `typst-cli` et Tinymist. ]

=== Regrouper les packages quand vous partagez

Les packages vivent à l'intérieur de votre boîte de notes, mais un package que vous avez seulement _téléchargé_ se trouve dans la mémoire cache partagée de votre machine, pas dans le dossier de la boîte de notes. Si vous collaborez ou partagez une boîte de notes, activez *Regrouper les packages Typst lors du partage* (dans le panneau de collaboration Git). InkyCap analyse alors les importations de vos notes et copie chaque package dont elles ont besoin dans la boîte de notes, afin que vos collaborateurs puissent compiler vos documents sans avoir à chercher quoi que ce soit. Voir #wikilink("1 - Collaboration") pour en savoir plus sur le partage.

== Pages connexes

- #wikilink("3 - Configurer votre boîte de notes")
- #wikilink("2 - Paramètres")
- #wikilink("4 - Rouleau de journal")
- #wikilink("1 - Collaboration")
