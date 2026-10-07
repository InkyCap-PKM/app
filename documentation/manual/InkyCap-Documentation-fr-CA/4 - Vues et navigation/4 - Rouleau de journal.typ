#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Rouleau de journal",
  description: "Comment utiliser le Rouleau de journal, le fil continu de notes d'InkyCap ordonné par date, y compris Chronologie et Voisinage, l'axe de tri, la portée d'ancrage, la navigation, le jumelage avec les notes quotidiennes et la composition d'une nouvelle note à partir des notes liées.",
  tags: ("documentation",),
)

= Rouleau de journal

Le Rouleau de journal vous laisse lire vos notes comme une seule chronologie continue. C'est un fil qui coule, où une note suit la suivante dans l'ordre chronologique. C'est idéal pour les notes quotidiennes, les journaux de recherche et la tenue d'un journal personnel.

La note sur laquelle vous travaillez actuellement dans l'éditeur est votre note de départ (l'_ancre_), et le fil affiche les notes qui viennent après elle dans le temps, chacune rendue telle qu'elle apparaît dans le Mode lecture HTML, empilées l'une sous l'autre. Le défilement vous emporte vers l'avant (ou vers l'arrière) à travers vos notes dans le temps.

Voyez-le comme un journal de votre propre écriture : un journal quotidien que vous pouvez parcourir, un carnet de recherche que vous pouvez survoler d'un bout à l'autre, ou une façon de revisiter une suite de notes connexes sans ouvrir chacune dans son propre onglet.

#callout("note")[ Le Rouleau de journal est une surface de lecture et de révision à l'intérieur de l'application, pas un aperçu d'impression. Le texte de son corps utilise la police de lecture de l'éditeur plutôt que celle de votre document. Il ne peut pas modifier vos notes ; l'activer ou le désactiver n'affecte que ce que vous voyez. ]

== Ouvrir et fermer le rouleau

Le Rouleau de journal est une vue par onglet : l'activer remplace l'éditeur dans l'onglet de la note *courante* par le fil, ancré sur la note que vous aviez ouverte. Il y a trois façons équivalentes de l'activer ou de le désactiver :

+ *Le bouton de l'en-tête de l'éditeur.* Dans le groupe de droite de l'en-tête de l'éditeur, cherchez l'icône de rouleau. Cliquez dessus pour démarrer le fil à partir de la note que vous consultez ; son infobulle indique « Rouleau de journal ancré à partir de cette note ». Cliquez de nouveau pour le désactiver.
+ *La palette de commandes.* Lancez la commande *Basculer le Rouleau de journal* (sous la catégorie Outils).
+ *Le clavier.* Appuyez sur `Ctrl+Shift+J`.

Les trois font la même chose : elles ancrent le fil sur la note active dans l'onglet courant. Le bouton de l'en-tête de l'éditeur n'est présent que lorsqu'un onglet de note (fichier) est ouvert. Si vous lancez la commande ou appuyez sur le raccourci sans note devant vous (un onglet vide, une collection ou une fenêtre fraîchement ouverte), InkyCap ouvre votre note modifiée le plus récemment dans un nouvel onglet et démarre le rouleau à partir de là.

Lorsque vous désactivez le rouleau, le fil et sa position de défilement enregistrée pour cet onglet sont écartés, et votre éditeur ordinaire revient intact.

== Chronologie et Voisinage

Pendant que le rouleau est actif, un interrupteur à deux positions dans l'en-tête de l'éditeur choisit les notes que contient le fil :

- *Chronologie* (par défaut) regroupe toutes les notes de votre *Portée de l'ancrage*, qui se déroulent dans le temps à partir de l'ancre. La plus grande partie de cette page la décrit.
- *Voisinage* regroupe l'ancre avec toutes les notes vers lesquelles elle renvoie et toutes les notes qui renvoient vers elle. L'ancre reste en haut et tout son voisinage suit en dessous, par ordre de date, pour qu'aucune note liée à l'ancre ne reste cachée de l'autre côté dans le temps. Le réglage *Portée de l'ancrage* ne s'applique pas ici.

En Voisinage, chaque note sauf l'ancre est réduite à ce qui la relie à l'ancre : chaque passage qui renvoie vers l'ancre, avec le paragraphe qui le précède et celui qui le suit. Une note vers laquelle l'ancre renvoie (et qui ne renvoie pas vers elle) montre plutôt son début. Un endroit où du texte a été laissé de côté s'affiche comme \[…\]. Quand une note contient davantage, une bande *Afficher plus* court en bas de la note ; cliquez dessus pour afficher toute la note sur place, puis sur *Afficher moins* pour la réduire de nouveau.

Changer de position reconstruit le fil à partir de l'ancre ; la direction de la date reste la même. Chaque fois que vous activez le rouleau, il commence en Chronologie.

== Comment le fil s'écoule

La note d'ancrage est toujours tout en haut du fil. À partir de là, le rouleau se déploie *vers le bas*. Pour voir les notes de l'autre côté de l'ancre dans le temps, vous inversez la direction de la date (voir les détails ci-dessous) ou vous réancrez sur une autre note.

Le fil charge par petits lots à mesure que vous défilez, donc même une grosse boîte de notes reste réactive : vous obtenez l'ancre plus une première poignée de notes, et d'autres apparaissent automatiquement à mesure que vous atteignez le bas. Quand vous arrivez à la fin et qu'il n'y a plus de notes à afficher, le fil cesse d'être défilable.

#callout("tip")[ Si jamais vous vous sentez « coincé » parce que le défilement ne vous ramène pas au-delà de votre note de départ, essayez le bouton à bascule de direction de la date pour pointer le fil dans l'autre sens dans le temps, ou ouvrez une autre note et réancrez là. ]

== Choisir comment les notes sont datées : « Trier par »

Parce que le Rouleau de journal est une _chronologie_, il a besoin de savoir par quelle propriété de date ordonner vos notes. Vous choisissez cela dans #wikilink("2 - Paramètres"), sous l'onglet *Comportement*, dans la section *Rouleau de journal*. Le contrôle est étiqueté *Trier par*, et il définit « l'axe selon lequel le fil est ordonné ». Vos options :

- *Date de création du fichier* ordonne les notes selon le moment où chaque fichier a été créé. C'est l'option par défaut.
- *Date de modification du fichier* ordonne selon le moment où chaque note a été modifiée pour la dernière fois.
- *Propriété zid de la note* ordonne selon l'identifiant Zettelkasten de la note, un long identifiant numérique défini soit comme propriété explicite, soit lu à partir du nom de fichier.
- *Propriété date de la note* ordonne selon la `date` que vous inscrivez dans les #wikilink("6 - Propriétés des notes") d'une note, ce qui est utile pour des entrées de journal datées à la main.

Ce réglage est enregistré par boîte de notes, donc chaque boîte de notes peut avoir sa propre chronologie.

#callout("important")[ Une note à laquelle manque la date que vous avez choisie est placée dans un second palier tout à la fin du fil, ordonnée par date de création du fichier. Donc rien ne disparaît ; cela se trie simplement en dernier. ]

#callout("warning")[ Si vous avez importé vos notes depuis un autre outil, leurs dates de création et de modification de fichier ont peut-être toutes été remises à la même journée. Dans ce cas, trier par *Propriété date de la note* (que vous rédigez vous-même) ou par le `zid` si vous avez importé un équivalent donne habituellement une chronologie plus fidèle que les dates de fichier. Voir #wikilink("2 - Importer des notes existantes"). ]

== Pointer le fil vers l'avant ou l'arrière dans le temps

Par défaut, le fil va des notes récentes vers les plus anciennes. Défiler vers le bas vous mène plus loin dans le passé. Vous pouvez inverser cela avec le bouton à bascule de *direction de la date*, qui vit dans le panneau de droite à côté de l'indicateur de contexte de défilement (pas sur le bouton de l'en-tête de l'éditeur).

Pendant que le rouleau est actif, l'en-tête de l'éditeur affiche une courte ligne d'état vous indiquant dans quel sens vous lisez, par exemple « Affichage du plus récent au plus ancien à partir de _\<nom de la note>_ » ou « Affichage du plus ancien au plus récent à partir de _\<nom de la note>_ ». Basculer la direction reconstruit le fil ; l'ancre reste en place, et seul le côté temporel qui se déploie vers le bas change. La direction se réinitialise à récent-d'abord chaque fois que vous activez le rouleau.

== Confiner le fil : « Portée de l'ancrage »

Par défaut, le fil peut puiser dans votre boîte de notes *entière*. Si vous préférez le garder dans une partie de votre boîte de notes (par exemple, un dossier qui ne contient que vos entrées de journal), utilisez le réglage *Portée de l'ancrage*, qui se trouve dans *Paramètres → Comportement → Rouleau de journal*. Il définit « le plus grand ensemble de notes que le fil peut afficher ». Vos options :

- *Toutes les notes* (la boîte de notes entière). C'est l'option par défaut.
- *Dossier des notes quotidiennes* confine le fil au dossier que vous avez sélectionné pour stocker les notes que la règle de création *Note du jour* écrit (et ses sous-dossiers).
- *Dossier personnalisé* révèle un champ *Dossier de portée personnalisée* où vous tapez un chemin de dossier, relatif à la racine de votre boîte de notes. Le fil est alors confiné à ce dossier et à tout ce qui se trouve en dessous.

Toutes les portées de dossier sont récursives : le dossier choisi _et_ ses sous-dossiers sont inclus. Comme *Trier par*, la portée de l'ancrage est enregistrée par boîte de notes.

#callout("note")[ Si vous choisissez *Dossier des notes quotidiennes* mais que votre règle Note du jour n'a pas de dossier cible fixe défini (sa destination est entièrement dynamique), il n'y a pas de dossier vers lequel se limiter, et le fil se rabat sur toutes les notes. Pour corriger cela, donnez à la règle Note du jour un dossier cible fixe sous vos règles de création. Voir #wikilink("3 - Configurer votre boîte de notes"). ]

== Le jumelage avec les notes quotidiennes

Le Rouleau de journal n'exige pas strictement de notes quotidiennes ; il lit n'importe quelles notes. Mais les deux se complètent. Réglez *Trier par* à *Propriété date de la note* (ou *Date de création du fichier*) et *Portée de l'ancrage* à *Dossier des notes quotidiennes*, et le fil devient un journal propre et chronologique que vous pouvez parcourir jour après jour.

Les notes qui remplissent ce dossier proviennent du scaffold *Note du jour* intégré, accessible avec `Ctrl+D`, qui crée une note datée dans votre dossier Quotidien. Pour apprendre comment fonctionnent les scaffolds et les règles de création, voir #wikilink("3 - Scaffolds, Templates et Packages").

== Lire et se déplacer dans une entrée

Chaque note du fil a son propre petit en-tête :

- *Titre.* Cliquez sur le titre de la note pour ouvrir cette note dans un nouvel onglet (utile quand vous voulez modifier la note).
- *Bouton d'avertissement de compilation.* Si une note a des problèmes de compilation (problèmes de mise en forme), un bouton d'avertissement apparaît. Les diagnostics restent cachés jusqu'à ce que vous l'ouvriez ; l'infobulle du bouton vous indique combien il y a de problèmes. Si une note n'a compilé qu'en partie, le fil affiche tout de même ce qu'il peut et saute la partie en erreur, avec une note expliquant pourquoi.
- *Badges de connexion.* De petites icônes montrant comment cette note se rapporte à votre ancre (décrites ci-dessous).

Les liens wiki à l'intérieur du fil sont futés quant à l'endroit où ils vous mènent :

- Un simple clic sur un lien dont la cible fait déjà partie de ce fil défile jusqu'à elle (ou, si elle n'est pas encore chargée, réancre le fil dessus pour qu'elle devienne le nouveau sommet).
- Un simple clic sur un lien _hors_ du fil courant l'ouvre dans un nouvel onglet.
- *Ctrl/Cmd-clic* ou *clic du milieu* ouvre toujours la cible dans un nouvel onglet.
- *Clic droit* ouvre le menu contextuel du lien avec ses choix d'ouverture.

Les flèches *précédent* et *suivant* de l'en-tête vous permettent de retracer les sauts de liens que vous avez faits _à l'intérieur_ du rouleau, distincts de l'historique ordinaire de votre onglet. Et dans le panneau de droite, un bouton *Revenir à la note d'ancrage* vous ramène instantanément au sommet du fil.

== Voir comment les notes se connectent à l'ancre

Le Rouleau de journal met en évidence comment chaque note se rapporte à votre ancre. Il n'y a pas de bouton à bascule pour activer ou désactiver cela. Une note qui se rapporte à l'ancre affiche une bande colorée le long de son bord gauche et un ou plusieurs badges d'icône correspondants dans son en-tête, chacun avec une infobulle. Les relations sont :

- *Note d'ancrage* est la note relativement à laquelle le fil défile.
- *Pointe vers la note d'ancrage* signifie que cette note contient un lien pointant vers l'ancre.
- *Lié depuis la note d'ancrage* signifie que l'ancre lie à cette note.
- *Partage une étiquette avec la note d'ancrage* signifie que cette note partage au moins une étiquette avec l'ancre.

Cela permet de repérer facilement, d'un coup d'œil, quelles notes de votre chronologie font partie de la même conversation. Pour en apprendre davantage sur ces relations, voir #wikilink("4 - Liens et rétroliens") et #wikilink("5 - Étiquettes").

== Le panneau de droite pendant que vous défilez

Quand le Rouleau de journal est actif, le panneau de droite met de côté ses onglets habituels de note unique et affiche plutôt *Contexte de défilement* (un résumé en direct des seules entrées actuellement en vue). Il inclut les contrôles de direction de la date et de retour à l'ancre (et, en Voisinage, le bouton *Composer* décrit plus bas), plus quatre sections repliables :

+ *Plan* liste les titres à travers toutes les notes visibles ; cliquez sur l'un d'eux pour défiler droit jusqu'à lui.
+ *Connexions* sont des notes _hors_ du fil qui lient vers ou depuis ce que vous lisez actuellement ; cliquez pour les ouvrir dans un nouvel onglet.
+ *Étiquettes* montre quelles étiquettes sont concentrées dans les notes à l'écran.
+ *Citations* sont les références citées à travers les notes visibles ; cliquez sur l'une d'elles pour mettre en évidence où elle apparaît.

Avant que vous ayez fait défiler une note dans la vue, ce panneau vous invite à « Faites défiler dans la vue pour remplir le contexte. » Pour en savoir plus sur les panneaux et la disposition d'ensemble, voir #wikilink("1 - Vues et navigation").

== Composer une nouvelle note à partir du voisinage

Les notes autour d'une idée sont souvent la matière première d'un nouveau texte : tout ce que vous avez écrit à son sujet, réuni au même endroit. *Composer* en fait une séance d'écriture.

En Voisinage, cliquez sur le bouton *Composer* dans le panneau de droite, juste après *Revenir à la note d'ancrage*. InkyCap crée une nouvelle note exactement comme le ferait *Ctrl+N*, avec vos réglages habituels de nom, de dossier, de modèle et de ZID, et l'ouvre dans l'éditeur. Le panneau de droite passe à l'onglet *Composer*, qui présente sous forme de fiches des passages des notes liées à l'ancre, la plus ancienne en premier (selon le ZID, puis la date de création) :

- Pour une note qui renvoie vers l'ancre, il y a une fiche pour chaque passage qui contient un tel lien.
- Pour une note vers laquelle l'ancre renvoie (et qui ne renvoie pas vers elle dans son texte), il y a une seule fiche qui contient le passage d'ouverture de la note, marquée *Début*.

Chaque fiche offre :

- *Copier la note entière dans le brouillon* insère toute la note de la fiche à l'emplacement du curseur, sans ses propriétés. Utilisez-le quand c'est la note entière, et non un seul passage, qui a sa place dans le nouveau texte.
- *Copier dans le brouillon* insère le passage tel quel à l'emplacement du curseur, prêt à être retravaillé. Utilisez-le pour vos propres textes que vous voulez reprendre sous une nouvelle forme.
- *Copier dans le brouillon sous forme de citation* l'insère comme citation en bloc, attribuée par un lien vers sa note.
- *Insérer un lien vers cette note* insère seulement le lien, quand vous préférez formuler l'idée à nouveau.
- *Écarter* masque la fiche pour cette séance.

Les quatre mêmes boutons d'insertion se trouvent en haut du panneau, à côté de *Tous les passages* ; ils insèrent toutes les fiches encore affichées, dans l'ordre affiché. Copier les notes entières copie chaque note une seule fois, même si elle a plusieurs fiches. Insérer les liens de plusieurs fiches produit une liste à puces avec un lien par note.

Faites glisser une fiche par sa poignée pour réordonner la liste ; disposer les fiches est une façon rapide de faire le plan du nouveau texte. Dès que votre brouillon contient un lien vers la note d'une fiche, la fiche pâlit pour que vous voyiez ce que vous n'avez pas encore utilisé. Cliquez sur le nom de la note d'une fiche pour l'ouvrir dans un nouvel onglet.

Le texte copié est une copie : modifier l'original plus tard ne change pas votre brouillon, et modifier le brouillon ne touche pas l'original. Les images et autres fichiers qu'utilise le texte copié continuent de fonctionner, où que le brouillon soit enregistré. Une note entière copiée laisse de côté tout appel `#bibliography(...)`, puisqu'un document ne peut en contenir qu'un. Pour garder la trace de la provenance du texte, chaque note dont vous copiez quelque chose (en entier, tel quel ou sous forme de citation) est ajoutée à la propriété *derived-from* du brouillon (voir #wikilink("6 - Propriétés des notes")). Ces entrées sont de vrais liens : les sources apparaissent dans les liens sortants du brouillon, et le brouillon dans les liens entrants de chaque source. Si vous renommez une note source, son entrée est mise à jour comme tous les autres liens vers elle.

L'onglet Composer appartient au brouillon et dure jusqu'à ce que vous fermiez l'onglet du brouillon. Un avis sous la barre d'outils du brouillon vous le rappelle, et son bouton *Afficher les fiches* ramène l'onglet Composer si vous êtes passé à un autre onglet du panneau de droite. Pour conserver un regroupement de notes liées que vous pourrez retrouver et exporter, utilisez plutôt une collection avec un filtre *Lien vers* (voir #wikilink("2 - Collections")).

== Un exemple

#callout("example")[ Supposons que vous tenez un journal de recherche quotidien.
+ Dans #wikilink("2 - Paramètres") → *Comportement* → *Rouleau de journal*, réglez *Trier par* à *Propriété date de la note* et *Portée de l'ancrage* à *Dossier des notes quotidiennes*.
+ Ouvrez la note quotidienne d'aujourd'hui (appuyez sur `Ctrl+D` pour en créer une au besoin).
+ Appuyez sur `Ctrl+Shift+J`. Le fil apparaît, ancré sur aujourd'hui et se déployant vers les jours antérieurs en dessous.
+ Défilez vers le bas pour revisiter la semaine dernière ; cliquez sur le titre d'une note pour l'ouvrir et la modifier, ou suivez un lien wiki pour sauter à une idée connexe.
+ Servez-vous du bouton d'ancre du panneau de droite pour bondir jusqu'à aujourd'hui quand bon vous semble. ]

== Pages connexes

- #wikilink("3 - Configurer votre boîte de notes") (dossiers, règles de création, et la règle Note du jour qui alimente le rouleau).
- #wikilink("3 - Scaffolds, Templates et Packages") (le scaffold de note quotidienne derrière les entrées datées).
- #wikilink("2 - Paramètres") (où vivent *Trier par* et *Portée de l'ancrage*).
- #wikilink("3 - Agenda, tâches et dates") (une autre façon de travailler avec les notes datées, les tâches et les échéances).
- #wikilink("1 - Vues et navigation") (comment le Rouleau de journal s'insère parmi les autres vues d'InkyCap).
- #wikilink("4 - Liens et rétroliens") (les liens qui forment un Voisinage).
