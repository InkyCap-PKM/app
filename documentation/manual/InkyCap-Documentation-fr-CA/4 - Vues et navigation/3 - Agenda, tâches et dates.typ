#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Agenda, tâches et dates",
  description: "Suivez vos choses à faire et vos échéances directement dans vos notes grâce aux tâches et aux rappels datés, puis voyez-les toutes rassemblées au même endroit dans le panneau Agenda.",
  tags: ("documentation",),
)

= Agenda, tâches et dates

Servez-vous des tâches et des dates pour garder le fil de ce que vous avez à faire et des dates à ne pas manquer (elles apparaîtront dans vos notes), puis voyez chacune d'elles rassemblée dans une seule liste. Si vous avez déjà éparpillé « finir le résumé » ou « subvention due vendredi » dans une douzaine de documents avant d'en perdre la trace, ceci va vous aider.

InkyCap repose sur deux idées :

- Une *tâche* est un élément à cocher. C'est quelque chose à faire, avec en option une date d'échéance et des étiquettes.
- Une *date* est un rappel daté autonome. C'est une échéance ou une sorte de jalon, sans case à cocher.

Vous les écrivez naturellement au fil de la frappe, et le panneau *Agenda* les recueille toutes, d'un bout à l'autre de votre boîte de notes, en un seul endroit que vous pouvez trier, filtrer et fouiller.

== Créer une tâche

Une tâche est une case que vous pouvez cocher comme terminée. Il y a trois façons faciles d'en créer une. Choisissez celle qui vous convient.

=== Le raccourci rapide : taper une case à cocher

Au début d'une ligne, tapez un marqueur de case à cocher suivi d'une espace :

- Tapez `- [ ] ` (un trait d'union, une espace, des crochets, une espace) et cela devient une tâche vide avec votre curseur prêt à l'intérieur.
- Tapez `- [x] ` et cela devient une tâche déjà marquée comme faite.

_C'est un raccourci de style Markdown qu'InkyCap reconnaît pour les tâches, mais qu'il traduit en balisage Typst approprié._ Votre indentation est conservée, donc les tâches imbriquées sous une liste restent là où vous les avez placées.

=== La commande slash

Tapez `/` n'importe où pendant que vous écrivez pour ouvrir le menu, regardez sous la catégorie *InkyCap* (ou tapez le mot `task` ou `due`), et choisissez :

- *Tâche* insère une tâche vide avec votre curseur à l'intérieur des guillemets.
- *Date d'échéance* insère un rappel daté vide.

Cela fonctionne aussi bien dans la vue d'écriture courante que dans le mode source. Si vous n'êtes pas certain du balisage exact, le menu slash est un chemin facile.

=== Une fois que vous avez une tâche

Une tâche apparaît comme une case à cocher avec le texte à côté. Vous pouvez aussi lui donner une date d'échéance et des étiquettes. Pour modifier l'un de ces éléments dans la vue d'écriture, cliquez sur la petite pastille `#` cerclée qui apparaît à côté de la tâche lorsque votre curseur est sur sa ligne. Un menu apparaît avec :

- un champ *Tâche* (texte indicatif : « Qu'y a-t-il à faire ? ») pour le texte de la tâche,
- un champ *Échéance* (texte indicatif : « AAAA-MM-JJ ») pour la date limite,
- et un bouton à bascule *Marquer comme faite* / *Marquer comme non faite*.

#callout("tip")[
  Pour cocher une tâche comme terminée, cliquez sur sa case. Le texte est barré, pour que vous voyiez d'un coup d'œil qu'elle est finie. Cliquez de nouveau pour la décocher.
]

== Créer un rappel daté autonome

Parfois, vous n'avez pas de chose à faire. Vous avez simplement une date à retenir, comme un colloque ou une fenêtre de soumission. C'est une *date* (un rappel daté). Insérez-en une avec la commande slash *Date d'échéance*, ou remplissez la pastille d'une date vide.

Un rappel daté apparaît comme un petit badge de date dans votre note. Cliquez sur sa pastille `#` pour définir :

- une *Date* (obligatoire ; un rappel doit avoir une date valide),
- et une *Description* facultative (texte indicatif : « Légende facultative ») pour donner le court texte que l'Agenda affichera pour lui.

#callout("important")[
  Si vous ne donnez pas de description à un rappel daté, l'Agenda n'a rien pour l'étiqueter, alors il se rabat sur le titre de la note. Si plusieurs rappels vivent dans la même note, donnez à chacun une description pour pouvoir les distinguer dans la liste.
]

== Une note entière comme un seul élément d'agenda

La troisième façon de créer une tâche (ou un élément à date d'échéance) est de marquer une *note entière* comme une tâche ou de lui donner une échéance, à l'aide de ses propriétés (voir #wikilink("6 - Propriétés des notes")).

Dans le panneau de propriétés en ligne, ajoutez :

- une case de propriété *task* (laissez-la décochée pour « à faire », cochez-la pour « fait ») ; ou
- une propriété *due* pour donner à la note entière une date d'échéance.

La note apparaîtra alors dans l'Agenda comme un seul élément, en utilisant son titre comme texte.

#callout("note")[
  Une simple propriété *date* ne place _pas_ une note dans l'Agenda. Bien des notes portent une `date` comme date de création ou de rédaction, et les inclure inonderait votre liste. Seule une propriété de date *due* ou une propriété *task* fait d'une note un élément d'agenda.
]

== Le panneau Agenda

L'Agenda rassemble chaque tâche et chaque rappel daté de toute votre boîte de notes pour les afficher dans une seule liste. Ouvrez-le à partir des boutons de la barre latérale gauche. Cherchez l'icône du calendrier avec un crochet (*Agenda*), qui se trouve juste après Collections.

Le panneau se tient à jour automatiquement à mesure que vous ajoutez, modifiez, terminez, renommez ou supprimez des choses.

=== Trier, filtrer et fouiller

Au-dessus de la liste, vous trouverez quelques contrôles :

+ *Liste de tâches* restreint ce qui est affiché : *Tout* (par défaut), *À faire*, *Fait*, ou *Dates seulement* (juste les rappels autonomes, sans cases à cocher).
+ *Étiquettes* n'affiche que les éléments portant les étiquettes que vous sélectionnez. C'est une sélection multiple qui correspond à n'importe laquelle des étiquettes que vous choisissez, et qui ne liste que les étiquettes réellement utilisées en ce moment. (Voir #wikilink("5 - Étiquettes").)
+ *Tri* offre un petit bouton de tri qui vous permet d'ordonner par *Échéance (plus tôt – plus tard)* (par défaut), *Échéance (plus tard – plus tôt)*, date de création, ZID ou nom, dans un sens ou dans l'autre. Les éléments sans valeur pour le critère de tri choisi tombent au bas de la liste.
+ Une boîte de recherche (*« Filtrer les éléments de l'agenda… »*) qui correspond au texte de l'élément, au titre de sa note ou à ses étiquettes.

=== Lire la liste

Chaque rangée vous dit d'un coup d'œil quel genre d'élément il s'agit :

- Une case à cocher (☑ fait, ☐ à faire) marque les tâches.
- Une petite icône d'horloge sur un calendrier marque les rappels datés autonomes.
- Les éléments datés affichent un badge de date. Si l'échéance d'une tâche *à faire* est _avant aujourd'hui_, la date est mise en surbrillance comme étant en retard pour qu'elle ressorte. (Les tâches terminées ne sont jamais signalées en retard.)

Les dates suivent le format que vous avez choisi dans #wikilink("2 - Paramètres") sous Apparence, pour qu'elles se lisent comme vous vous y attendez.

=== Ouvrir et terminer des éléments

- *Cliquez sur une rangée* pour sauter directement à la note qui la contient. *Ctrl/Cmd-clic* ou *clic du milieu* l'ouvre plutôt dans un nouvel onglet, et *clic droit* vous donne *Ouvrir* et *Ouvrir dans un nouvel onglet*.

#callout("warning")[
  La case à cocher affichée dans la liste de l'Agenda est un indicateur d'état, pas un bouton. Cliquer sur une rangée ouvre la note plutôt que de cocher la tâche. Pour réellement marquer quelque chose comme fait, faites-le dans la note elle-même : cliquez sur la case de la tâche dans la vue d'écriture, utilisez son menu de pastille, ou basculez la propriété *task* pour un élément de note entière.
]

== Les tâches dans les callouts et les citations

Vous n'êtes pas limité à écrire des tâches dans le fil principal d'une note. Une tâche placée à l'intérieur d'un callout, d'une citation en bloc ou d'une annotation apparaît toujours comme une case à cocher fonctionnelle, et vous pouvez la cocher directement là sans l'ouvrir pour la modifier.

== Le balisage littéral

#callout("tip", title: "Pour les utilisateurs de Typst")[
  Les tâches et les rappels datés sont de véritables appels de fonctions Typst du package `inkycap-notebox` intégré, importé automatiquement dans chaque note. Tout ce qui précède est une interface conviviale par-dessus celles-ci :

  ```typ
  #task("Draft abstract")                              // open task
  #task("Draft abstract", done: true)                  // completed
  #task("Submit", due: "2026-06-23", tags: ("work",))  // dated + tagged
  #task("Submit", due: datetime(year: 2026, month: 6, day: 23))
  #due("2026-07-01")                                   // bare dated reminder
  #due("2026-07-01", label: "Keynote")                 // labelled
  ```

  Le `body` d'un `#task` est une chaîne obligatoire ; `done:` vaut `false` par défaut ; `tags:` accepte une chaîne ou un tableau. Un `#due` exige une date valide et prend un `label:` facultatif.

  Les dates acceptent soit une chaîne ISO entre guillemets (`"2026-06-23"`), soit un `datetime(...)` ; les deux s'affichent correctement, et l'axe des dates est canoniquement ISO `YYYY-MM-DD` partout. Les éditeurs de pastille écrivent toujours la forme entre guillemets. Au niveau du document, votre `#note(...)` peut porter `task: true|false` et `due: "YYYY-MM-DD"` pour faire de la note entière un seul élément d'agenda.

  Les deux primitives émettent une étiquette `<inkycap-agenda>` interrogeable, c'est ainsi que l'Agenda les trouve à travers la boîte de notes.
]

== L'agenda propre à une collection

Si vous organisez des notes dans une #wikilink("2 - Collections", display: "collection"), cette collection peut afficher ses membres sous forme d'*Agenda* plutôt que de tableau. C'est pratique, par exemple, pour un cours ou un projet précis : chaque tâche et chaque échéance appartenant à cette collection apparaîtra dans une vue ciblée.

Pour en configurer un, ouvrez le tableau de la collection, utilisez *Ajouter une vue* (le bouton *+*) et choisissez *Vue Agenda*. Le résultat utilise la même fonctionnalité de liste d'Agenda que vous connaissez déjà, mais limitée aux seuls membres de cette collection. (L'appartenance suit le filtre de la collection ; une note apparaît parce qu'elle correspond à ce filtre, et non à cause d'un marqueur manuel.)

== Pages connexes

- #wikilink("6 - Propriétés des notes") (marquer une note entière comme une tâche ou lui donner une échéance).
- #wikilink("5 - Étiquettes") (catégoriser les tâches et filtrer l'Agenda par étiquette).
- #wikilink("2 - Collections") (construire une vue d'agenda limitée à une collection).
- #wikilink("4 - Rouleau de journal") (pour une écriture orientée par dates, jour après jour).
- #wikilink("2 - Paramètres") (choisir comment les dates sont affichées).
- #wikilink("3 - Raccourcis clavier") (des façons plus rapides de vous déplacer dans InkyCap).
