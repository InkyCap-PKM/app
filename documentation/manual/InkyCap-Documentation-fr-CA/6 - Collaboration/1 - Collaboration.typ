#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Collaboration",
  description: "Comment travailler avec d'autres personnes sur une boîte de notes partagée dans InkyCap : synchronisation Git en direct ou échange de packages hors ligne, le modèle « fusion d'abord », la révision des changements et la rétroaction.",
  tags: ("documentation",),
  aliases: ("Collaboration",),
)

= Collaboration

InkyCap offre des fonctions de collaboration de base (pas en temps réel). Vous pouvez partager une boîte de notes avec des collaborateurs pour que vos modifications et les leurs se mêlent automatiquement, tout en gardant le contrôle sur les changements. Cette page explique comment activer la collaboration, les deux façons de partager et comment réviser ce qui vous arrive.

#callout("important")[
  La collaboration demeure une fonction quelque peu *expérimentale*. Vous pourriez croiser quelques aspérités.

InkyCap n'offre pas de fonctions de collaboration avancées. Les fonctions actuelles peuvent suffire pour deux personnes ou un peu plus, mais elles risquent de ne pas convenir à un flux de travail au sein d'une grande équipe de collaborateurs. De plus, si vous faites de nombreux changements rapides en va-et-vient, vous serez mieux servi par une collaboration Typst en temps réel, comme le système offert par #link("https://typst.app/").
]

== Comment fonctionne la collaboration

Quelques idées rendent tout le reste plus facile à comprendre.

- *Vous partagez une boîte de notes entière, pas des notes isolées.* Quand une boîte de notes est collaborative, _tout_ ce qu'elle contient est partagé. Si vous voulez garder certaines notes privées, conservez-les dans une boîte de notes distincte. Voyez #wikilink("3 - Configurer votre boîte de notes") pour savoir comment organiser plusieurs boîtes de notes.
- *La collaboration est facultative, une boîte de notes à la fois.* Ce n'est jamais un interrupteur global, tout ou rien.
- InkyCap conserve un historique de chaque version, alors les changements avec lesquels vous n'êtes pas d'accord peuvent être annulés par la suite.

=== L'idée de « fusion d'abord » (à retenir !)

InkyCap suit une approche de _fusion d'abord_, qui est au cœur de la fonction de collaboration :

+ Quand vous récupérez des mises à jour, InkyCap *les fusionne tout de suite*. Il ne vous demandera pas de démêler un conflit au beau milieu de votre travail.
+ Là où votre modification et celle d'un collaborateur touchent les *mêmes lignes*, InkyCap garde la version de *votre collaborateur* et signale la note, au cas où vous voudriez annuler le changement ou comparer votre modification avec celle de votre collaborateur.
+ *Vous révisez et annulez par la suite, à votre rythme.* Comme l'historique complet est conservé, tout ce que vous voulez récupérer n'est qu'à un clic.

Le flux de travail est le suivant : les changements entrent proprement, le rare chevauchement accepte la formulation de votre collaborateur, puis vous passez en revue ce qui est arrivé et vous annulez tout ce que vous préférez garder à votre façon. Aucune invite du type « résolvez ce conflit maintenant ».

#callout("note")[
  InkyCap ne vérifie *pas* de lui-même les mises à jour de vos collaborateurs. C'est voulu. Votre boîte de notes reste tranquillement locale jusqu'à ce que _vous_ demandiez des mises à jour en cliquant sur *Synchroniser* ou *Vérifier les mises à jour*.
]

== Les deux façons de partager

Vous en choisissez une avec un seul interrupteur lors de la configuration. Les deux se comportent de la même manière une fois que vous travaillez (même fusion, même révision, même historique).

- *Synchronisation en ligne*. Votre boîte de notes se connecte à un dépôt partagé sur un service d'hébergement (comme Codeberg.org, GitHub ou un autre serveur git de votre choix). Tout le monde se synchronise sur la même copie en ligne. Idéal pour une collaboration continue et en va-et-vient. #highlight[Soyez attentif aux *considérations de confidentialité* et assurez-vous que vous ou vos collaborateurs configurez le dépôt en ligne de façon appropriée].
- *Échange de packages hors ligne*. Il n'y a aucun serveur. Vous exportez la boîte de notes entière dans un seul fichier (un `.zip`), vous le transférez comme bon vous semble, puis vous fusionnez le fichier d'un collaborateur lorsqu'il vous le retourne. Idéal quand vous ne voulez pas, ou ne pouvez pas, utiliser un serveur git en ligne, ou quand vous exigez plus de garanties de confidentialité.

== Activer la collaboration

Vous activez la collaboration par boîte de notes sous *Paramètres › Gestion des boîtes de notes*. Pour en savoir plus sur la fenêtre des Paramètres, voyez #wikilink("2 - Paramètres").

+ Ouvrez les *Paramètres* et trouvez la section *Gestion des boîtes de notes*.
+ Repérez votre boîte de notes dans la liste. Sa rangée comporte un interrupteur *Collaboration* (avec une icône de poignée de main).
+ Mettez l'interrupteur *en marche*. Cela ouvre la boîte de notes et affiche le formulaire de configuration *Collaboration via Git*.
+ Remplissez le formulaire (ci-dessous) et choisissez *Configurer la collaboration*.

Une fois la collaboration activée, un bouton *Configurer* apparaît à côté de l'interrupteur pour que vous puissiez revenir aux paramètres en tout temps.

=== Le formulaire de configuration

Le formulaire demande quelques renseignements :

- *Hors ligne (échange manuel de boîtes de notes)*. Laissez cette option désactivée pour la synchronisation en ligne ; activez-la pour le transfert de packages par fichier. Vous pourrez passer à un serveur en ligne plus tard si vous commencez hors ligne.
- *Adresse du dépôt*. L'adresse web du dépôt partagé (pour la synchronisation en ligne), par exemple un lien `https://` que votre collaborateur vous donne.
- *Nom d'utilisateur* et *Mot de passe*. Vos identifiants de connexion au service d'hébergement.
- *Branche*. Laissez la valeur par défaut, `main`, à moins que vous ne la changiez expressément sur le serveur git que vous utilisez.
- *Votre nom et votre adresse courriel*. Une *étiquette* affichée sur vos changements pour que les collaborateurs puissent voir qui a fait chaque modification. C'est seulement une étiquette, pas un identifiant de connexion. InkyCap la préremplit si vous avez déjà un nom configuré.

#callout("tip")[
  Certains services (comme GitHub, ou tout compte avec vérification en deux étapes) exigent un « mot de passe d'application » spécial que vous créez dans les paramètres de sécurité de ce service, plutôt que votre mot de passe de connexion habituel. Votre mot de passe est géré et stocké dans le trousseau de votre système d'exploitation. Il n'est jamais conservé à l'intérieur de la boîte de notes elle-même.
]

#callout("tip", title: "Configurations avancées")[
  Il existe un interrupteur *Avancé* « Se connecter avec SSH plutôt » qui vous connecte à l'aide des clés SSH existantes de votre machine au lieu d'un nom d'utilisateur et d'un mot de passe ; choisissez-le seulement si vous utilisez déjà SSH avec ce service. Les détails de connexion (le dépôt distant et la branche) résident par machine dans `.inkycap/local.json`, et _non_ dans le `settings.json` partagé. L'étiquette d'auteur se rabat sur le `git config` `user.name` / `user.email` de votre système, ce qui explique pourquoi les commits peuvent afficher un nom système. C'est normal.

L'interrupteur « `Bundle Typst packages on share` » (désactivé par défaut) inclut tous les packages Typst additionnels installés dans la boîte de notes pour que les collaborateurs puissent compiler hors ligne ; les packages `@preview` se téléchargent automatiquement pour chaque personne.
]

== Rejoindre la boîte de notes collaborative de quelqu'un d'autre

Si un collaborateur a tout configuré et vous a invité, vous le rejoignez à partir de *Paramètres › Gestion des boîtes de notes* à l'aide de l'un des deux boutons en haut de la liste des boîtes de notes :

- *Cloner depuis un dépôt distant*. Rejoignez une boîte de notes collaborative en ligne. Saisissez l'adresse qu'on vous a donnée, choisissez un dossier *vide* sur votre ordinateur pour accueillir la boîte de notes, puis sélectionnez *Cloner et ouvrir*. La boîte de notes arrive prête à la collaboration.
- *Importer un package*. Transformez en une nouvelle boîte de notes un package `.zip` qu'on vous a envoyé. Choisissez le fichier et un dossier de destination vide, puis choisissez *Importer et ouvrir*.

#callout("note")[
  Comme les détails de connexion sont conservés par ordinateur, une boîte de notes fraîchement clonée peut s'ouvrir comme _non_ collaborative jusqu'à ce que vous vous reconnectiez. Quand cela arrive, le volet Collaboration offre un bouton *Reconnecter la collaboration* en un clic qui adopte le lien existant sans rien à saisir.
]

== Comment accéder aux fonctions de collaboration

La collaboration se trouve dans un volet de la *barre latérale gauche*. Vous pouvez l'ouvrir à partir de :

- La *pastille de la barre d'état* au bas de la fenêtre (une icône de poignée de main accompagnée d'un bref résumé d'état), qui apparaît _seulement sur les boîtes de notes où la collaboration est activée_.
- Le bouton *Configurer* dans Paramètres › Gestion des boîtes de notes.
- La *palette de commandes*, sous la catégorie « Collaboration ».

== Synchronisation en ligne (usage quotidien)

Dans la section *Synchroniser les changements* du volet, vous trouverez deux boutons :

- *Synchroniser* est l'action principale. Elle intègre les changements de vos collaborateurs, les fusionne et repartage les vôtres, le tout en une seule étape. Une fois terminée, vous verrez un bref message comme « Synchronisé (3 notes modifiées) », « Déjà à jour » ou « Vos changements sont partagés ».
- *Vérifier les mises à jour* est une action d'aperçu seulement. Elle vous indique si quelque chose de nouveau vous attend (« 2 mises à jour disponibles. Synchronisez pour les obtenir ») *sans* rien changer dans votre boîte de notes. Utilisez-la quand vous voulez simplement savoir si un collaborateur a fait des changements.

Le volet affiche aussi une courte ligne d'état (par exemple « Aucun changement local » quand vous êtes à jour, « Changements à partager » quand vous avez du travail à envoyer, ou « 2 entrants ») et un aperçu « Fichiers que vous partagerez » pour que vous voyiez exactement ce qu'une prochaine synchronisation transportera.

== Échange de packages hors ligne (usage quotidien)

Quand vous avez choisi le mode *Hors ligne*, le volet affiche plutôt *Importer/exporter les changements*, avec :

- *Exporter le package* écrit votre boîte de notes entière dans un fichier `.zip` que vous pouvez envoyer à un collaborateur.
- *Importer le package* fusionne dans votre boîte de notes un `.zip` qu'un collaborateur vous a envoyé, en utilisant le même comportement de fusion d'abord que la synchronisation en ligne.
- Un *mot de passe d'archive* facultatif. Laissez-le vide pour aucun chiffrement, ou définissez-en un pour chiffrer le package (AES-256). Partagez ce mot de passe séparément.

#callout("danger")[
  Comme toute fonction protégée par mot de passe dans InkyCap, *InkyCap ne stocke pas le mot de passe*. Si vous définissez un mot de passe d'archive et que vous le perdez, le package ne pourra pas être ouvert. Conservez votre mot de passe en lieu sûr et partagez-le avec vos collaborateurs par un canal distinct. Le même mot de passe d'exportation déverrouille le package à l'importation.
]

L'échange hors ligne est une synchronisation manuelle de pair à pair (même fusion, mêmes outils de révision, même historique des versions). Les seules choses propres au mode en ligne sont l'adresse, le nom d'utilisateur, le mot de passe et les champs de connexion SSH.

== Réviser ce qui est arrivé

Après chaque synchronisation ou importation de package, le volet Collaboration vous donne un portrait clair de ce qui a changé.

=== Fichiers modifiés depuis la dernière synchronisation

C'est votre liste principale du « ce qui vient d'arriver ». Elle nomme chaque note dans laquelle la dernière synchronisation a intégré des changements. Pour chaque note, vous pouvez :

- *Cliquer sur la rangée* pour ouvrir la note et révéler sa vue des changements.
- *Annuler* toute cette note pour revenir à votre version d'avant la synchronisation, à l'aide de l'icône d'annulation (flèche circulaire).

Les notes où la modification d'un collaborateur a chevauché la vôtre portent un badge clair (« collision : version du collaborateur acceptée ») et se trient en haut pour être faciles à repérer et à revérifier. Une note qui comporte aussi des suggestions ouvertes affiche « _N_ suggestion(s) en attente de rétroaction ».

#callout("note")[
  Cette liste est un registre continu de ce qui a changé depuis votre dernière synchronisation, pas une liste de tâches à liquider. Annuler une note ne l'efface pas de la liste ; la liste se rafraîchit simplement à votre prochaine synchronisation.
]

=== La vue des changements par note

Ouvrez n'importe quelle note révisée et le volet *Changements et historique* de la barre latérale droite affiche deux parties :

- *Entrants depuis la dernière synchronisation* montre les changements de votre collaborateur. Vous pouvez sauter à chaque changement dans la note, annuler un seul changement, ou *Tout annuler* pour rétablir votre version complète d'avant la synchronisation.
- *Activité locale depuis la dernière synchronisation* montre vos propres modifications récentes, à titre de référence.

=== Changements à résoudre

Séparément, le volet tient une liste *Changements à résoudre* : les notes qui contiennent des suggestions insérées intentionnellement et en attente de votre décision d'accepter ou de rejeter (abordée plus loin). Vos propres suggestions n'y sont pas comptées. Seules celles des autres qui attendent votre décision y apparaissent.

== Donner de la rétroaction : suggestions et annotations

En plus du partage, InkyCap vous donne deux façons douces de commenter un brouillon sans l'écraser. Ce sont des outils manuels que vous utilisez quand bon vous semble et qui sont inclus dans le processus de synchronisation.

- *Les annotations* sont des _commentaires_ visibles (une remarque ou une question qui ne change pas le texte). Elles apparaissent sous forme de callout teinté à côté du contenu. Elles sont différentes des commentaires Typst en ligne qui commencent par `//` et qui ne sont pas visibles dans un résultat.
- *Les suggestions* sont des _changements_ proposés qui restent marqués comme en attente jusqu'à ce que quelqu'un les accepte ou les rejette. Il en existe trois sortes : suggérer une insertion, une suppression ou un remplacement.

Vous ajoutez l'une ou l'autre au texte que vous avez sélectionné, à l'aide de la palette de commandes (sous la catégorie « Édition ») ou des boutons au bas du volet des changements :

- *Ajouter une annotation*
- *Suggérer une insertion*
- *Suggérer une suppression*
- *Suggérer un remplacement*

Pour agir sur une suggestion, cliquez dessus (dans l'éditeur visuel, elle apparaît comme une petite pastille) pour ouvrir un menu *Accepter* / *Rejeter*, où vous pouvez aussi laisser un commentaire à l'auteur.

#callout("important")[
  Accepter ou rejeter une suggestion la retire entièrement du texte. Une insertion acceptée devient du texte ordinaire, et une insertion rejetée disparaît. Cela signifie qu'un document fini que vous publiez ou exportez ne porte *jamais* de marques de suggestion résiduelles. Voyez #wikilink("3 - Exportation et publication").
]

== Historique des versions et restauration

Chaque note collaborative conserve son historique complet. Dans le volet *Changements et historique*, passez de *Changements* à *Historique* pour voir les versions antérieures, la plus récente en premier (la version actuelle porte le badge « actuelle »).

Pour toute version antérieure, vous pouvez :

- *La restaurer*. Cela ramène l'ancien contenu sous la forme d'un _nouveau_ changement que vous pourrez ensuite synchroniser. C'est non destructif : les versions antérieures restent dans l'historique, et rien n'est écrasé de façon permanente.
- *La comparer*. Cela ouvre une vue côte à côte en lecture seule de cette version par rapport à la note actuelle, où vous pouvez restaurer la note entière ou seulement un fragment.
- *Ouvrir à côté* pour voir l'ancienne version dans une division à côté de votre note actuelle.

Si une synchronisation a déjà gardé la version d'un collaborateur par-dessus l'une des vôtres, l'entrée concernée porte le badge « votre version précédente (remplacée par la dernière synchronisation) », pour que vous puissiez toujours trouver et restaurer exactement ce que vous aviez écrit.

#callout("note")[
  Les historiques des versions sont une fonction de la collaboration et n'apparaissent qu'une fois la boîte de notes configurée pour la collaboration. D'ici là, l'onglet Historique vous renverra à Paramètres › Gestion des boîtes de notes pour activer la collaboration.
]

== Arrêter ou ajuster la collaboration

Dans le volet Collaboration, la section *Gérer la collaboration* vous permet de modifier plus tard n'importe lequel de vos détails de configuration (adresse, branche, connexion, identité, et le mode en ligne ou hors ligne) et de les enregistrer avec un seul bouton. Laissez le mot de passe vide pour conserver celui que vous avez déjà enregistré.

Pour arrêter complètement, choisissez *Cesser de collaborer*. Cela retire seulement le lien de collaboration d'InkyCap. Vos fichiers et leur historique restent sur votre ordinateur local. Il y a une case à cocher facultative pour supprimer aussi l'historique des versions afin de récupérer de l'espace disque, ce qui ne peut pas être annulé.

== Raccourcis clavier

Quelques actions de collaboration ont des raccourcis (voyez #wikilink("3 - Raccourcis clavier") pour la liste complète) :

- *Synchroniser* : Ctrl+Shift+S
- *Vérifier les mises à jour* : Ctrl+Shift+U
- *Exporter le package* : Ctrl+Shift+E (mode hors ligne)
- *Importer le package* : Ctrl+Shift+G (mode hors ligne)

Si vous exécutez une commande dans le mauvais mode (par exemple, Exporter en mode en ligne), InkyCap se contente de vous expliquer quoi faire à la place plutôt que d'agir.

== Pages connexes

- #wikilink("3 - Configurer votre boîte de notes")
- #wikilink("2 - Paramètres")
- #wikilink("2 - Modifier des notes")
- #wikilink("3 - Exportation et publication")
- #wikilink("3 - Raccourcis clavier")
